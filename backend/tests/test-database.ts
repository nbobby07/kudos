import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

/** Never infer test credentials from the application database or a .env file. */
export async function testDatabase(source: NodeJS.ProcessEnv = process.env) {
  if (source.TEST_DATABASE_URL) return { connectionString: source.TEST_DATABASE_URL, close: async () => {} };
  const name = `verification-test-${randomUUID()}`;
  const password = randomUUID();
  const docker = (args: string[]) => exec("docker", args, { timeout: 60_000 });
  const close = async () => {
    try { await docker(["rm", "--force", "--volumes", name]); }
    catch { throw new Error("Disposable verification Postgres cleanup failed"); }
  };
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432",
      "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=verification_test", "postgres:17"]);
    const { stdout } = await docker(["port", name, "5432/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error("Missing disposable Postgres loopback port");
    const url = new URL(`postgresql://127.0.0.1:${port}/verification_test`);
    url.username = "postgres";
    url.password = password;
    const connectionString = url.href;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
      let ready = false;
      try {
        await client.connect();
        await client.query("SELECT 1");
        ready = true;
      } catch { /* Wait for PostgreSQL to finish initialization. */ }
      finally { await client.end().catch(() => {}); }
      if (ready) return { connectionString, close };
      await delay(100);
    }
    throw new Error("Disposable Postgres readiness deadline exceeded");
  } catch {
    await close().catch(() => {});
    // Child-process errors can contain generated credentials in their command text.
    throw new Error("Cannot start disposable verification Postgres. Enable Docker or explicitly supply TEST_DATABASE_URL for a disposable database.");
  }
}
