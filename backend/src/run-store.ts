import type { JobStore } from "./jobs.js";
import type { RunStore } from "./server.js";

export function createRunStore(jobs: Pick<JobStore, "enqueue" | "getRun">): RunStore {
  return {
    async createAndEnqueue(submission, key) {
      // enqueue commits the run and job in one transaction before returning.
      const runId = await (key === undefined ? jobs.enqueue(submission) : jobs.enqueue(submission, key));
      if (key !== undefined) {
        const result = await jobs.getRun(runId);
        if (!result) throw new Error("Accepted run is missing");
        return result;
      }
      return { ...submission, runId, state: "queued", evidenceRefs: [] };
    },
    getRun: (runId) => jobs.getRun(runId),
  };
}
