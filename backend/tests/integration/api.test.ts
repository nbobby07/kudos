import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/database.js";
import { JobStore } from "../../src/jobs.js";
import { createRunStore } from "../../src/run-store.js";
import { createApiServer } from "../../src/server.js";
import { testDatabase } from "../test-database.js";

const database = await testDatabase();
const { connectionString } = database;
const schema = `api_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const createPool = () => new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const teamToken = "synthetic-demo-team-token-32-characters";
const headers = { Authorization: `Bearer ${teamToken}`, "Content-Type": "application/json" };
const projects = [{ id: "test-checkout", repositoryUrl: "https://example.invalid/checkout.git",
  setupCommand: "npm ci", startCommand: "npm start" }];
const submission = { projectId: projects[0].id, commitSha: "abcdef01".repeat(5),
  requirementId: "declined-payment-retry" };
let pool: pg.Pool;
let jobs: JobStore;
let server: ReturnType<typeof createApiServer>;
let url: string;

async function start() {
  pool = createPool();
  jobs = new JobStore(pool, projects);
  server = createApiServer({ teamToken, projects, runStore: createRunStore(jobs) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrationPool = createPool();
  try { await migrate(migrationPool); } finally { await migrationPool.end(); }
});
beforeEach(async () => {
  await start();
  await pool.query("TRUNCATE verification_runs CASCADE");
});
afterEach(stop);
afterAll(async () => {
  try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { try { await admin.end(); } finally { await database.close(); } }
});

it("API persists and enqueues atomically, survives reconnect, and polls real worker progress/results", async () => {
  const response = await fetch(`${url}/submissions`, { method: "POST", headers, body: JSON.stringify(submission) });
  expect(response.status).toBe(202);
  const { runId } = await response.json() as { runId: string };
  expect(response.headers.get("location")).toBe(`/runs/${runId}`);
  const { rows } = await pool.query("SELECT run_id, state FROM verification_jobs");
  expect(rows).toEqual([{ run_id: runId, state: "queued" }]);
  await stop();
  await start();
  const poll = async () => {
    const result = await fetch(`${url}/runs/${runId}`, { headers });
    expect(result.status).toBe(200);
    return result.json();
  };
  expect(await poll()).toEqual({ ...submission, runId, state: "queued", evidenceRefs: [] });
  const claim = await jobs.claim();
  expect(claim?.runId).toBe(runId);
  expect(await poll()).toMatchObject({ ...submission, state: "preparing" });
  await jobs.markVerifying(claim!);
  expect(await poll()).toMatchObject({ ...submission, state: "verifying" });
  const evidenceId = randomUUID();
  await jobs.addEvidence(claim!, { id: evidenceId, kind: "log", storageKey: "private/log.txt",
    contentType: "text/plain", byteSize: 10 });
  await jobs.finish(claim!, { state: "completed", outcome: "failed" });
  expect(await poll()).toEqual({ ...submission, runId, state: "completed", outcome: "failed",
    evidenceRefs: [{ id: evidenceId, kind: "log" }] });
});

it("API rejects failed job insertion without leaving a run or returning an accepted ID", async () => {
  await pool.query("ALTER TABLE verification_jobs ADD CONSTRAINT reject_jobs CHECK (false) NOT VALID");
  try {
    const response = await fetch(`${url}/submissions`, { method: "POST", headers, body: JSON.stringify(submission) });
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "Run service unavailable" });
    expect((await pool.query("SELECT * FROM verification_runs")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM verification_jobs")).rows).toEqual([]);
  } finally {
    await pool.query("ALTER TABLE verification_jobs DROP CONSTRAINT reject_jobs");
  }
});
