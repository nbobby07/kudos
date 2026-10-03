import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_EVIDENCE_BYTES, type EvidenceStore } from "./evidence-storage.js";
import type { ExecutionVm } from "./freestyle.js";
import type { JobClaim, JobStore } from "./jobs.js";

const guestEvidenceSchema = z.strictObject({
  network: z.literal("network.json"), logs: z.literal("logs.json"), screenshot: z.literal("failure.png").optional(),
}).optional();
export const checkoutTerminalSchema = z.discriminatedUnion("state", [
  z.strictObject({ requirementId: z.literal("declined-payment-retry"), state: z.literal("completed"), outcome: z.enum(["passed", "failed"]), evidence: guestEvidenceSchema }),
  z.strictObject({ requirementId: z.literal("declined-payment-retry"), state: z.literal("error"), errorCode: z.enum(["environment", "tooling", "timeout", "interrupted"]), evidence: guestEvidenceSchema }),
]);

export async function readCheckoutReport(vm: ExecutionVm, signal: AbortSignal) {
  const bytes = await vm.fs.readFile("/tmp/verification-evidence/result.json", { length: 16_385, signal });
  signal.throwIfAborted();
  if (bytes.length > 16_384) throw new Error("Guest report too large");
  return checkoutTerminalSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

const networkSchema = z.array(z.strictObject({
  attempt: z.number().int().min(1).max(100), method: z.literal("POST"), path: z.literal("/checkout"), status: z.literal(402),
})).max(100);
const logSchema = z.array(z.strictObject({
  event: z.enum(["page-error", "request-failed", "requirement-passed", "requirement-failed", "check-interrupted", "check-error",
    "screenshot-unavailable", "browser-cleanup-failed", "console-log", "console-debug", "console-info", "console-error",
    "console-warning", "console-dir", "console-dirxml", "console-table", "console-trace", "console-clear",
    "console-startGroup", "console-startGroupCollapsed", "console-endGroup", "console-assert", "console-profile",
    "console-profileEnd", "console-count", "console-timeEnd"]),
  step: z.enum(["launch", "navigate", "submit", "declined-error", "retry"]),
})).max(100);

/** Upload bytes before registering fenced metadata; never trust guest paths or raw logs. */
export async function persistGuestEvidence(options: {
  vm: ExecutionVm;
  signal: AbortSignal;
  claim: JobClaim;
  jobs: Pick<JobStore, "addEvidence">;
  storage: EvidenceStore;
  includeScreenshot?: boolean;
  onDiagnostic?: (event: "evidence-artifact-unavailable") => void;
}) {
  const refs: { id: string; kind: "screenshot" | "network" | "log" }[] = [];
  for (const [name, kind] of [["network.json", "network"], ["logs.json", "log"], ["failure.png", "screenshot"]] as const) {
    if (kind === "screenshot" && options.includeScreenshot === false) continue;
    const id = randomUUID();
    let uploadAttempted = false;
    try {
      options.signal.throwIfAborted();
      let bytes = Buffer.from(await options.vm.fs.readFile(`/tmp/verification-evidence/${name}`, {
        length: MAX_EVIDENCE_BYTES + 1, signal: options.signal,
      }));
      options.signal.throwIfAborted();
      if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence too large");
      if (kind === "screenshot") {
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid PNG");
      } else {
        const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        bytes = Buffer.from(JSON.stringify((kind === "network" ? networkSchema : logSchema).parse(json)));
      }
      uploadAttempted = true;
      await options.storage.put(id, bytes);
      options.signal.throwIfAborted();
      await options.jobs.addEvidence(options.claim, {
        id, kind, storageKey: id, contentType: kind === "screenshot" ? "image/png" : "application/json", byteSize: bytes.length,
      });
      refs.push({ id, kind });
    } catch {
      if (uploadAttempted) await options.storage.delete(id).catch(() => {});
      try { options.onDiagnostic?.("evidence-artifact-unavailable"); } catch { /* Preserve the primary check. */ }
      if (options.signal.aborted) break;
    }
  }
  return refs;
}
