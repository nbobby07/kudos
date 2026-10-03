import { loadEnv } from "./env.js";
import { createApiServer } from "./server.js";
import { createDatabase } from "./database.js";
import { JobStore } from "./jobs.js";
import { createRunStore } from "./run-store.js";
import { EvidenceStorage } from "./evidence-storage.js";

try {
  const env = loadEnv();
  const pool = createDatabase(env.DATABASE_URL);
  pool.on("error", () => console.error("API database connection failed"));
  const jobs = new JobStore(pool);
  const storage = new EvidenceStorage(env.EVIDENCE_DIRECTORY);
  const server = createApiServer({ teamToken: env.DEMO_TEAM_TOKEN,
    runStore: createRunStore(jobs), evidenceStore: {
      getEvidence: (runId, id) => jobs.getEvidence(runId, id),
      read: (key) => storage.get(key),
    } });
  server.on("close", () => {
    void pool.end().catch(() => {
      console.error("API database shutdown failed");
      process.exitCode = 1;
    });
  });
  server.on("error", () => {
    console.error("API server failed to listen");
    process.exitCode = 1;
    server.close();
  });
  server.listen(env.PORT, env.HOST, () => {
    console.info(`API listening on ${env.HOST}:${env.PORT}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
    });
  }
} catch {
  console.error("API startup failed; check server environment configuration");
  process.exitCode = 1;
}
