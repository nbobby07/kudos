import { EnvironmentError, withFreestyleApp, type ExecutionVm } from "./freestyle.js";
import { persistGuestEvidence, readCheckoutReport } from "./evidence.js";
import type { EvidenceStore } from "./evidence-storage.js";
import type { JobClaim, JobStore } from "./jobs.js";

/** Executor building block; the worker must retain its claim through finalization. */
export async function verifyCheckoutInFreestyle(options: Parameters<typeof withFreestyleApp>[0] & {
  claim: JobClaim;
  jobs: Pick<JobStore, "markVerifying" | "addEvidence">;
  storage: EvidenceStore;
  prepareRunner?: (vm: ExecutionVm, signal: AbortSignal, deadline: number) => Promise<void>;
  runnerCommand?: string;
}): Promise<Parameters<JobStore["finish"]>[1]> {
  try {
    const report = await withFreestyleApp(options, async ({ vm, appUrl, signal, deadline }) => {
      await options.prepareRunner?.(vm, signal, deadline);
      await options.jobs.markVerifying(options.claim);
      const execution = await vm.exec({
        command: options.runnerCommand ?? "node /opt/verifier/dist/checkout-runner.js /tmp/verification-evidence",
        env: { APP_URL: appUrl, CI: "1", NODE_ENV: "test" }, timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())),
      });
      signal.throwIfAborted();
      try {
        // A valid primary report survives timeout/failure during guest artifact writes.
        return await readCheckoutReport(vm, signal);
      } catch {
        throw new EnvironmentError(execution.statusCode == null ? "timeout" : "tooling", "Checkout report unavailable");
      }
    }, async ({ vm, signal, result }) => {
      await persistGuestEvidence({ vm, signal, claim: options.claim, jobs: options.jobs, storage: options.storage,
        includeScreenshot: !(result?.state === "completed" && result.outcome === "passed"),
        onDiagnostic: () => console.error("evidence-artifact-unavailable") });
    });
    return report.state === "completed" ? { state: "completed", outcome: report.outcome } :
      { state: "error", errorCode: report.errorCode };
  } catch (error) {
    return { state: "error", errorCode: error instanceof EnvironmentError ? error.code : "tooling" };
  }
}
