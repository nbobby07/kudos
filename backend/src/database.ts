import { readFile } from "node:fs/promises";
import pg from "pg";

export function createDatabase(connectionString: string) {
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000 });
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize migrations across concurrently starting server processes.
    await client.query("SELECT pg_advisory_xact_lock(81734102)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    for (const version of ["001_verification", "002_integration_context"]) {
      const applied = await client.query("SELECT version FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount === 0) {
        const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
