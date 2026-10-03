import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { createVerificationSchemas, type Submission, type VerificationResult } from "./submission.js";
import { supportedProjects, type TrustedProject } from "./projects.js";

export type JobClaim = { jobId: string; runId: string; token: string };
export class SubmissionConflictError extends Error {
  constructor() { super("Idempotency key is already bound to another submission"); this.name = "SubmissionConflictError"; }
}
type TerminalResult = Extract<VerificationResult, { state: "completed" | "error" }>;
export const evidenceMetadataSchema = z.strictObject({
  id: z.uuid(), kind: z.enum(["screenshot", "log", "network"]),
  storageKey: z.string().min(1), contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;

export class JobStore {
  private readonly schemas;
  constructor(private readonly pool: pg.Pool, projects: readonly TrustedProject[] = supportedProjects) {
    this.schemas = createVerificationSchemas(projects);
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueue(input: Submission, key?: string): Promise<string> {
    const submission = this.schemas.submissionSchema.parse(input);
    if (key !== undefined) key = z.uuid().parse(key).toLowerCase();
    const runId = randomUUID();
    return this.transaction(async (client) => {
      if (key !== undefined) {
        const inserted = await client.query(`INSERT INTO submission_keys(key, run_id, submission)
          VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING run_id`, [key, runId, submission]);
        if (inserted.rowCount === 0) {
          const { rows } = await client.query("SELECT run_id, submission FROM submission_keys WHERE key = $1 FOR UPDATE", [key]);
          const old = rows[0].submission;
          if (old.projectId !== submission.projectId || old.commitSha !== submission.commitSha
            || old.requirementId !== submission.requirementId) throw new SubmissionConflictError();
          return rows[0].run_id as string;
        }
      }
      await client.query(`INSERT INTO verification_runs(id, project_id, commit_sha, requirement_id)
        VALUES ($1, $2, $3, $4)`, [runId, submission.projectId, submission.commitSha, submission.requirementId]);
      await client.query("INSERT INTO verification_jobs(id, run_id) VALUES ($1, $2)", [randomUUID(), runId]);
      return runId;
    });
  }

  async getRun(runId: string): Promise<VerificationResult | null> {
    const { rows } = await this.pool.query(`SELECT r.*, COALESCE(
      (SELECT json_agg(json_build_object('id', e.id, 'kind', e.kind) ORDER BY e.created_at, e.id)
       FROM verification_evidence e WHERE e.run_id = r.id), '[]'::json) AS evidence_refs
      FROM verification_runs r WHERE r.id = $1`, [runId]);
    const row = rows[0];
    if (!row) return null;
    return this.schemas.resultSchema.parse({
      runId: row.id, projectId: row.project_id, commitSha: row.commit_sha,
      requirementId: row.requirement_id, state: row.state, evidenceRefs: row.evidence_refs,
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    });
  }

  async getEvidence(runId: string, id: string): Promise<EvidenceMetadata | null> {
    const { rows } = await this.pool.query(`SELECT id, kind, storage_key, content_type, byte_size
      FROM verification_evidence WHERE run_id = $1 AND id = $2`, [runId, id]);
    const row = rows[0];
    if (!row) return null;
    return evidenceMetadataSchema.parse({ id: row.id, kind: row.kind,
      storageKey: row.storage_key, contentType: row.content_type, byteSize: Number(row.byte_size) });
  }

  async claim(leaseMs = 30_000): Promise<JobClaim | null> {
    this.validateLease(leaseMs);
    return this.transaction(async (client) => {
      const { rows } = await client.query(`SELECT id, run_id FROM verification_jobs
        WHERE state = 'queued' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!rows[0]) return null;
      const claim = { jobId: rows[0].id as string, runId: rows[0].run_id as string, token: randomUUID() };
      await client.query(`UPDATE verification_jobs SET state = 'claimed', claim_token = $2,
        lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond' WHERE id = $1`,
      [claim.jobId, claim.token, leaseMs]);
      await client.query(`UPDATE verification_runs SET state = 'preparing', updated_at = clock_timestamp()
        WHERE id = $1`, [claim.runId]);
      return claim;
    });
  }

  private validateLease(leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Lease must be a positive integer");
  }

  private async lockClaim(client: pg.PoolClient, claim: JobClaim) {
    // Every mutation is fenced by both the token and the unexpired lease.
    const { rowCount } = await client.query(`SELECT id FROM verification_jobs
      WHERE id = $1 AND run_id = $2 AND claim_token = $3 AND state = 'claimed'
      AND lease_expires_at > clock_timestamp() FOR UPDATE`, [claim.jobId, claim.runId, claim.token]);
    if (rowCount !== 1) throw new Error("Job claim lost or expired");
  }

  async heartbeat(claim: JobClaim, leaseMs = 30_000) {
    this.validateLease(leaseMs);
    await this.transaction(async (client) => {
      await this.lockClaim(client, claim);
      await client.query(`UPDATE verification_jobs SET lease_expires_at = clock_timestamp()
        + $2 * interval '1 millisecond' WHERE id = $1`, [claim.jobId, leaseMs]);
    });
  }

  async markVerifying(claim: JobClaim) {
    await this.transaction(async (client) => {
      await this.lockClaim(client, claim);
      await client.query(`UPDATE verification_runs SET state = 'verifying', updated_at = clock_timestamp()
        WHERE id = $1 AND state = 'preparing'`, [claim.runId]);
    });
  }

  async addEvidence(claim: JobClaim, input: EvidenceMetadata) {
    const evidence = evidenceMetadataSchema.parse(input);
    await this.transaction(async (client) => {
      await this.lockClaim(client, claim);
      await client.query(`INSERT INTO verification_evidence(id, run_id, kind, storage_key, content_type, byte_size)
        VALUES ($1, $2, $3, $4, $5, $6)`, [evidence.id, claim.runId, evidence.kind,
      evidence.storageKey, evidence.contentType, evidence.byteSize]);
    });
  }

  async finish(claim: JobClaim, result: Pick<Extract<TerminalResult, { state: "completed" }>, "state" | "outcome">
    | Pick<Extract<TerminalResult, { state: "error" }>, "state" | "errorCode">) {
    const terminal = z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("completed"), outcome: z.enum(["passed", "failed", "unverified"]) }),
      z.strictObject({ state: z.literal("error"), errorCode: z.enum(["environment", "tooling", "timeout", "interrupted"]) }),
    ]).parse(result);
    await this.transaction(async (client) => {
      await this.lockClaim(client, claim);
      const { rowCount } = await client.query(`UPDATE verification_runs SET state = $2, outcome = $3,
        error_code = $4, updated_at = clock_timestamp() WHERE id = $1
        AND (state = 'verifying' OR ($2 = 'error' AND state = 'preparing'))`,
      [claim.runId, terminal.state, terminal.state === "completed" ? terminal.outcome : null,
        terminal.state === "error" ? terminal.errorCode : null]);
      if (rowCount !== 1) throw new Error("Run is not ready for this terminal result");
      await client.query(`UPDATE verification_jobs SET state = 'finished', claim_token = NULL,
        lease_expires_at = NULL WHERE id = $1`, [claim.jobId]);
    });
  }

  async recoverInterrupted(): Promise<number> {
    return this.transaction(async (client) => {
      const { rows } = await client.query(`SELECT id, run_id FROM verification_jobs WHERE state = 'claimed'
        AND lease_expires_at <= clock_timestamp() FOR UPDATE SKIP LOCKED`);
      for (const row of rows) {
        await client.query(`UPDATE verification_runs SET state = 'error', error_code = 'interrupted',
          outcome = NULL, updated_at = clock_timestamp() WHERE id = $1`, [row.run_id]);
        await client.query(`UPDATE verification_jobs SET state = 'finished', claim_token = NULL,
          lease_expires_at = NULL WHERE id = $1`, [row.id]);
      }
      return rows.length;
    });
  }
}
