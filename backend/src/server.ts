import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { demoTeamTokenSchema } from "./env.js";
import { supportedProjects, type TrustedProject } from "./projects.js";
import { createVerificationSchemas, type Submission, type VerificationResult } from "./submission.js";
import { evidenceMetadataSchema, SubmissionConflictError, type EvidenceMetadata } from "./jobs.js";
import { MAX_EVIDENCE_BYTES } from "./evidence-storage.js";

export interface EvidenceDownloadStore {
  getEvidence(runId: string, id: string): Promise<EvidenceMetadata | null>;
  read(key: string): Promise<Buffer>;
}

export interface RunStore {
  // Resolve only after the run and its job are durably committed together.
  // Never wait for VM execution. Rejection must not leave an accepted orphan run.
  createAndEnqueue(submission: Submission, key?: string): Promise<VerificationResult>;
  getRun(runId: string): Promise<VerificationResult | null>;
}

export function createApiServer(options: {
  teamToken?: string;
  projects?: readonly TrustedProject[];
  runStore?: RunStore;
  evidenceStore?: EvidenceDownloadStore;
} = {}) {
  const token = options.teamToken === undefined ? undefined : demoTeamTokenSchema.parse(options.teamToken);
  const schemas = createVerificationSchemas(options.projects ?? supportedProjects);
  const maxBodyBytes = 16 * 1024;
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/health") {
      // Liveness only; database and verification readiness come in later steps.
      send(200, { status: "ok" });
      return;
    }
    const path = request.url?.split("?")[0];
    const isSubmission = path === "/submissions";
    const isRun = path?.startsWith("/runs/");
    if (!isSubmission && !isRun) {
      send(404, { error: "Not found" });
      return;
    }
    // Authenticate before parsing bodies, validating IDs, or touching storage.
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const authCount = request.rawHeaders.filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === "authorization").length;
    if (!token || authCount !== 1 || Buffer.byteLength(supplied) !== Buffer.byteLength(token)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.setHeader("Connection", "close");
      send(401, { error: "Unauthorized" });
      return;
    }
    if (request.method !== (isSubmission ? "POST" : "GET")) {
      response.setHeader("Allow", isSubmission ? "POST" : "GET");
      send(405, { error: "Method not allowed" });
      return;
    }
    const key = isSubmission ? request.headers["idempotency-key"] : undefined;
    const keyCount = request.rawHeaders.filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === "idempotency-key").length;
    if (isSubmission && (keyCount > 1 || (key !== undefined && !z.uuid().safeParse(key).success))) {
      send(400, { error: "Invalid Idempotency-Key" });
      return;
    }
    const evidencePath = isRun ? /^\/runs\/([^/]+)\/evidence\/([^/]+)$/.exec(path!) : null;
    const runId = evidencePath ? evidencePath[1] : isRun ? path!.slice("/runs/".length) : undefined;
    if (runId !== undefined && !z.uuid().safeParse(runId).success) {
      send(400, { error: "Invalid run ID" });
      return;
    }
    if (evidencePath) {
      const evidenceId = evidencePath[2];
      if (!z.uuid().safeParse(evidenceId).success) {
        send(400, { error: "Invalid evidence ID" });
        return;
      }
      if (!options.evidenceStore) {
        send(503, { error: "Evidence service unavailable" });
        return;
      }
      try {
        const record = await options.evidenceStore.getEvidence(runId!, evidenceId);
        if (record === null) {
          send(404, { error: "Evidence not found" });
          return;
        }
        const metadata = evidenceMetadataSchema.parse(record);
        if (metadata.id !== evidenceId || !z.uuid().safeParse(metadata.storageKey).success
          || metadata.byteSize > MAX_EVIDENCE_BYTES
          || metadata.contentType !== (metadata.kind === "screenshot" ? "image/png" : "application/json")) {
          throw new Error("Invalid evidence metadata");
        }
        const bytes = await options.evidenceStore.read(metadata.storageKey);
        if (!Buffer.isBuffer(bytes) || bytes.length !== metadata.byteSize || bytes.length > MAX_EVIDENCE_BYTES) {
          throw new Error("Invalid evidence bytes");
        }
        response.setHeader("Content-Type", metadata.contentType);
        response.setHeader("Content-Length", bytes.length);
        response.writeHead(200);
        response.end(bytes);
      } catch {
        send(503, { error: "Evidence service unavailable" });
      }
      return;
    }
    if (!options.runStore) {
      send(503, { error: "Run storage and queue unavailable" });
      return;
    }
    try {
      if (runId !== undefined) {
        const record = await options.runStore.getRun(runId);
        if (record === null) {
          send(404, { error: "Run not found" });
          return;
        }
        const result = schemas.resultSchema.parse(record);
        if (result.runId !== runId) throw new Error("Run identity mismatch");
        send(200, result);
        return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
        send(415, { error: "Expected application/json" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          response.setHeader("Connection", "close");
          send(413, { error: "Request body too large" });
          return;
        }
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        send(400, { error: "Invalid JSON" });
        return;
      }
      const submission = schemas.submissionSchema.safeParse(body);
      if (!submission.success) {
        send(400, { error: "Invalid submission" });
        return;
      }
      const result = schemas.resultSchema.parse(await (key === undefined
        ? options.runStore.createAndEnqueue(submission.data)
        : options.runStore.createAndEnqueue(submission.data, (key as string).toLowerCase())));
      if ((key === undefined && result.state !== "queued") || result.projectId !== submission.data.projectId
        || result.commitSha !== submission.data.commitSha || result.requirementId !== submission.data.requirementId) {
        throw new Error("Invalid queued run");
      }
      response.setHeader("Location", `/runs/${result.runId}`);
      send(202, { runId: result.runId });
    } catch (error) {
      // Do not disclose storage errors, credentials, or unsanitized records.
      if (!response.headersSent && !response.destroyed) {
        if (error instanceof SubmissionConflictError) send(409, { error: "Idempotency key conflict" });
        else send(503, { error: "Run service unavailable" });
      }
    }
  });
}
