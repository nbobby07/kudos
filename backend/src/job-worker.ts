import { setTimeout as delay } from "node:timers/promises";
import { JobStore, type JobClaim } from "./jobs.js";

export type JobExecutor = (claim: JobClaim, signal: AbortSignal) => Promise<Parameters<JobStore["finish"]>[1]>;

// Only the worker shutdown signal controls execution, never an HTTP request signal.
export async function executeNextJob(store: JobStore, execute: JobExecutor, shutdown: AbortSignal,
  leaseMs = 30_000): Promise<boolean> {
  if (shutdown.aborted) return false;
  await store.recoverInterrupted();
  const claim = await store.claim(leaseMs);
  if (!claim) return false;
  const execution = new AbortController();
  const heartbeatStop = new AbortController();
  const onShutdown = () => execution.abort();
  shutdown.addEventListener("abort", onShutdown, { once: true });
  if (shutdown.aborted) execution.abort();
  let rejectInterrupted: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = () => reject(new Error("Execution interrupted"));
    execution.signal.addEventListener("abort", rejectInterrupted, { once: true });
  });
  const heartbeat = (async () => {
    try {
      while (!heartbeatStop.signal.aborted) {
        await delay(Math.max(1, Math.floor(leaseMs / 3)), undefined, { signal: heartbeatStop.signal });
        await store.heartbeat(claim, leaseMs);
      }
    } catch {
      if (!heartbeatStop.signal.aborted) execution.abort();
    }
  })();
  try {
    execution.signal.throwIfAborted();
    const result = await Promise.race([execute(claim, execution.signal), interrupted]);
    execution.signal.throwIfAborted();
    await store.finish(claim, result);
  } catch {
    // A lost lease prevents stale writes; the recovery loop will persist interruption.
    await store.finish(claim, { state: "error", errorCode: execution.signal.aborted ? "interrupted" : "tooling" })
      .catch(() => {});
  } finally {
    heartbeatStop.abort();
    await heartbeat;
    shutdown.removeEventListener("abort", onShutdown);
    execution.signal.removeEventListener("abort", rejectInterrupted);
  }
  return true;
}
