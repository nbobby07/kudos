import { loadEnv } from "./env.js";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "./database.js";
import { JobStore } from "./jobs.js";
import { executeNextJob } from "./job-worker.js";
import { createFreestyleExecutor } from "./executor.js";
import { EvidenceStorage } from "./evidence-storage.js";

try {
  const env = loadEnv();
  const pool = createDatabase(env.DATABASE_URL);
  pool.on("error", () => console.error("Worker database connection failed"));
  const store = new JobStore(pool);
  const executor = createFreestyleExecutor(store, new EvidenceStorage(env.EVIDENCE_DIRECTORY));
  let active: ReturnType<typeof executor> | undefined;
  const execute: typeof executor = (claim, signal) => {
    active = executor(claim, signal);
    return active;
  };
  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => shutdown.abort());
  }
  try {
    console.info("Worker started; Freestyle execution and recovery enabled");
    while (!shutdown.signal.aborted) {
      if (!await executeNextJob(store, execute, shutdown.signal)) {
        await delay(1_000, undefined, { signal: shutdown.signal }).catch(() => {});
      }
      // The queue interruption race can finish before VM evidence collection/deletion.
      await active?.catch(() => {});
      active = undefined;
    }
  } finally {
    await active?.catch(() => {});
    await pool.end();
  }
} catch {
  console.error("Worker startup or recovery failed");
  process.exitCode = 1;
}
