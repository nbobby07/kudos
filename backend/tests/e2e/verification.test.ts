import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCheckout } from "../../src/checkout.js";
import { migrate } from "../../src/database.js";
import { EvidenceStorage } from "../../src/evidence-storage.js";
import { executeNextJob } from "../../src/job-worker.js";
import { JobStore } from "../../src/jobs.js";
import { createRunStore } from "../../src/run-store.js";
import { createApiServer } from "../../src/server.js";
import type { VerificationResult } from "../../src/submission.js";
import { testDatabase } from "../test-database.js";

// Local execution only: no Freestyle VM or production executor.
// API authentication, queue/leases, report storage, Git checkout, and Chromium are real.
const database = await testDatabase();
const { connectionString } = database;
const fixture = JSON.parse(await readFile(new URL("../../../fixtures/checkout-revisions.json", import.meta.url), "utf8")) as {
  projectId: string; revisions: { broken: string; fixed: string }; setupCommand: string; startCommand: string;
};
const repository = fileURLToPath(new URL("../../../fixtures/checkout", import.meta.url));
const projects = [{ id: fixture.projectId, repositoryUrl: "https://local-fixture.invalid/checkout.git",
  setupCommand: fixture.setupCommand, startCommand: fixture.startCommand }];
const teamToken = "synthetic-local-verification-team-token";
const headers = { Authorization: `Bearer ${teamToken}`, "Content-Type": "application/json" };
const schema = `verification_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const createPool = () => new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const exec = promisify(execFile);
let pool: pg.Pool;
let jobs: JobStore;
let server: ReturnType<typeof createApiServer>;
let url: string;
let evidenceDirectory: string;
let evidence: EvidenceStorage;

async function startApi() {
  pool = createPool();
  jobs = new JobStore(pool, projects);
  evidence = new EvidenceStorage(evidenceDirectory);
  server = createApiServer({ teamToken, projects, runStore: createRunStore(jobs), evidenceStore: {
    getEvidence: (runId, id) => jobs.getEvidence(runId, id), read: (key) => evidence.get(key),
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stopApi() {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const migrationPool = createPool();
  try { await migrate(migrationPool); } finally { await migrationPool.end(); }
  evidenceDirectory = await mkdtemp("/tmp/opencode/verification-storage-");
  await startApi();
});
afterAll(async () => {
  try {
    if (server) await stopApi();
    if (evidenceDirectory) await rm(evidenceDirectory, { recursive: true, force: true });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally { try { await admin.end(); } finally { await database.close(); } }
});

async function report(runId: string): Promise<VerificationResult> {
  const response = await fetch(`${url}/runs/${runId}`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as VerificationResult;
}

describe("verification local adapter (real Postgres/Git/Chromium, not live Freestyle)", () => {
  it.each([
    { revision: "broken" as const, startupFailure: false, state: "completed", outcome: "failed" },
    { revision: "fixed" as const, startupFailure: false, state: "completed", outcome: "passed" },
    { revision: "fixed" as const, startupFailure: true, state: "error", outcome: undefined },
  ])("$revision startupFailure=$startupFailure preserves exact SHA and returns $state/$outcome", async (scenario) => {
    const commitSha = fixture.revisions[scenario.revision];
    const submission = { projectId: fixture.projectId, commitSha, requirementId: "declined-payment-retry" };
    const unauthorized = await fetch(`${url}/submissions`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) });
    expect(unauthorized.status).toBe(401);
    expect((await pool.query("SELECT count(*)::int AS count FROM verification_jobs WHERE state = 'queued'")).rows[0].count).toBe(0);
    const accepted = await fetch(`${url}/submissions`, { method: "POST", headers, body: JSON.stringify(submission) });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json() as { runId: string };
    expect(accepted.headers.get("location")).toBe(`/runs/${runId}`);
    expect(await report(runId)).toEqual({ ...submission, runId, state: "queued", evidenceRefs: [] });
    expect((await fetch(`${url}/runs/${runId}`)).status).toBe(401);

    let appDirectory = "";
    let app: ChildProcess | undefined;
    let checkedSha = "";
    let cleaned = false;
    let browserInvoked = false;
    // This callback is the explicit local test adapter, not a shipped worker executor.
    const consumed = await executeNextJob(jobs, async (claim, signal) => {
      expect(claim.runId).toBe(runId);
      expect(await report(runId)).toMatchObject({ ...submission, state: "preparing" });
      appDirectory = await mkdtemp("/tmp/opencode/verification-app-");
      try {
        await exec("git", ["clone", "--no-checkout", "--local", repository, appDirectory], { timeout: 5000, signal });
        await exec("git", ["checkout", "--detach", commitSha], { cwd: appDirectory, timeout: 5000, signal });
        checkedSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: appDirectory, signal })).stdout.trim();
        expect(checkedSha).toBe(commitSha);
        const env = { PATH: process.env.PATH, HOME: appDirectory, CI: "1", NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0" };
        await exec("sh", ["-c", fixture.setupCommand], { cwd: appDirectory, env, timeout: 5000, signal });
        // Inject a real startup process failure without changing the submitted Git revision.
        app = spawn(scenario.startupFailure ? process.execPath : "sh",
          scenario.startupFailure ? ["--eval", "process.exit(23)"] : ["-c", `exec ${fixture.startCommand}`], {
          cwd: appDirectory, env, stdio: ["ignore", "pipe", "ignore"],
        });
        const appUrl = await new Promise<string>((resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => reject(new Error("Local startup deadline exceeded")), 5000);
          app!.stdout!.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/listening on (http:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]!); }
          });
          app!.once("error", () => { clearTimeout(timer); reject(new Error("Local startup failed")); });
          app!.once("exit", () => { clearTimeout(timer); reject(new Error("Local startup exited")); });
        }).catch(() => null);
        if (!appUrl) return { state: "error", errorCode: "environment" };
        expect((await fetch(appUrl)).status).toBe(200);
        await jobs.markVerifying(claim);
        expect(await report(runId)).toMatchObject({ ...submission, state: "verifying" });
        browserInvoked = true;
        const result = await checkCheckout({ appUrl, assertionTimeoutMs: 500, signal });
        const artifacts = [
          { kind: "log" as const, contentType: "application/json", bytes: Buffer.from(JSON.stringify(result.evidence.logs)) },
          { kind: "network" as const, contentType: "application/json", bytes: Buffer.from(JSON.stringify(result.evidence.network)) },
          ...(result.evidence.screenshot ? [{ kind: "screenshot" as const, contentType: "image/png", bytes: result.evidence.screenshot }] : []),
        ];
        // Use production byte storage outside the local execution directory before cleanup.
        for (const artifact of artifacts) {
          const id = randomUUID();
          const storageKey = id;
          await evidence.put(storageKey, artifact.bytes);
          await jobs.addEvidence(claim, { id, kind: artifact.kind, storageKey,
            contentType: artifact.contentType, byteSize: artifact.bytes.length });
        }
        return result.state === "completed" ? { state: result.state, outcome: result.outcome } :
          { state: result.state, errorCode: result.errorCode };
      } finally {
        if (app && app.exitCode === null && app.signalCode === null) {
          const exited = once(app, "exit");
          app.kill("SIGKILL");
          await exited;
        }
        await rm(appDirectory, { recursive: true, force: true });
        cleaned = true;
      }
    }, new AbortController().signal);
    expect(consumed).toBe(true);
    expect(cleaned).toBe(true);
    expect(checkedSha).toBe(commitSha);
    await expect(access(appDirectory)).rejects.toThrow();
    expect(browserInvoked).toBe(!scenario.startupFailure);
    expect(app?.exitCode !== null || app?.signalCode !== null).toBe(true);

    const terminal = await report(runId);
    expect(terminal).toMatchObject({ ...submission, state: scenario.state });
    expect(JSON.stringify(terminal)).not.toContain(evidenceDirectory);
    if (scenario.startupFailure) {
      expect(terminal).toMatchObject({ errorCode: "environment", evidenceRefs: [] });
      expect(terminal).not.toHaveProperty("outcome");
      expect(app?.exitCode).toBe(23);
    } else {
      expect(terminal).toMatchObject({ outcome: scenario.outcome });
      expect(terminal).not.toHaveProperty("errorCode");
      expect(terminal.evidenceRefs.map((item) => item.kind).sort()).toEqual(
        scenario.revision === "broken" ? ["log", "network", "screenshot"] : ["log", "network"]);
    }
    expect((await pool.query("SELECT state FROM verification_jobs WHERE run_id = $1", [runId])).rows).toEqual([{ state: "finished" }]);
    // Reconnect both API and database after application cleanup, then read persisted reports/bytes.
    await stopApi();
    await startApi();
    expect(await report(runId)).toEqual(terminal);
    const { rows } = await pool.query("SELECT * FROM verification_evidence WHERE run_id = $1", [runId]);
    expect(rows).toHaveLength(terminal.evidenceRefs.length);
    for (const row of rows) {
      expect(terminal.evidenceRefs).toContainEqual({ id: row.id, kind: row.kind });
      const downloadUrl = `${url}/runs/${runId}/evidence/${row.id}`;
      expect((await fetch(downloadUrl)).status).toBe(401);
      expect((await fetch(`${url}/runs/${randomUUID()}/evidence/${row.id}`, { headers })).status).toBe(404);
      const download = await fetch(downloadUrl, { headers });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe(row.content_type);
      expect(download.headers.get("cache-control")).toBe("no-store");
      const bytes = Buffer.from(await download.arrayBuffer());
      expect(bytes).toEqual(await evidence.get(row.storage_key));
      expect(bytes.length).toBe(Number(row.byte_size));
      if (row.kind === "screenshot") {
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(bytes.length).toBeGreaterThan(100);
      } else if (row.kind === "network") {
        expect(JSON.parse(bytes.toString())).toEqual(Array.from({ length: scenario.revision === "broken" ? 1 : 2 },
          (_, index) => ({ attempt: index + 1, method: "POST", path: "/checkout", status: 402 })));
      } else {
        expect(JSON.parse(bytes.toString())).toContainEqual(scenario.revision === "broken" ?
          { event: "requirement-failed", step: "declined-error" } : { event: "requirement-passed", step: "retry" });
      }
    }
    expect(await executeNextJob(jobs, async () => { throw new Error("Unexpected duplicate execution"); },
      new AbortController().signal)).toBe(false);
  });
});
