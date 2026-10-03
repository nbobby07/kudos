import { createDatabase, migrate } from "./database.js";
import { loadEnv } from "./env.js";

const pool = createDatabase(loadEnv().DATABASE_URL);
try {
  await migrate(pool);
  console.info("Database migrations applied");
} catch {
  console.error("Database migration failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
