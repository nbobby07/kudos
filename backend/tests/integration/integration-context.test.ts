import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "../../src/database.js";
import { IntegrationContextStore, IntegrationConflictError, type IntegrationRecord } from "../../src/integration-context.js";
import { JobStore, SubmissionConflictError } from "../../src/jobs.js";
import { createRunStore } from "../../src/run-store.js";
import { createApiServer } from "../../src/server.js";
import { testDatabase } from "../test-database.js";

const database = await testDatabase();
const schema = `context_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: database.connectionString });
const createPool = () => new pg.Pool({ connectionString: database.connectionString, options: `-c search_path=${schema}` });
const pool = createPool();
const projects = [{ id: "test-checkout", repositoryUrl: "https://example.invalid/checkout.git",
  setupCommand: "npm ci", startCommand: "npm start" }];
const submission = { projectId: projects[0].id, commitSha: "abcdef01".repeat(5), requirementId: "declined-payment-retry" as const };
const context = { sender: { name: "Sender" }, recipient: { name: "Recipient" }, contractSnapshot: { version: 1 } };
const store = () => new IntegrationContextStore(pool, "workspace", "backend");
const manifest = JSON.parse(await readFile(new URL("../../../fixtures/checkout-revisions.json", import.meta.url), "utf8")) as {
  projectId: string; revisions: Record<string, string>;
};
const pinnedSubmission = { projectId: manifest.projectId, commitSha: Object.values(manifest.revisions)[0],
  requirementId: "declined-payment-retry" as const };
type BrowserSnapshot = { revision: number; runs: Omit<IntegrationRecord, "upstreamKey">[] };

async function rootHarness() {
  const dataDir = await mkdtemp("/tmp/opencode/integration-root-");
  const jobs = new JobStore(pool);
  const durable = createRunStore(jobs);
  let statusUnavailable = false;
  let dropAcknowledgement = false;
  const submittedKeys: (string | undefined)[] = [];
  const teamToken = "synthetic-demo-team-token-32-characters";
  const backend = createApiServer({ teamToken, runStore: {
    async createAndEnqueue(input, key) {
      submittedKeys.push(key);
      const result = await durable.createAndEnqueue(input, key);
      if (dropAcknowledgement) { dropAcknowledgement = false; backend.closeAllConnections(); }
      return result;
    },
    async getRun(runId) {
      if (statusUnavailable) throw new Error("Injected status outage");
      return durable.getRun(runId);
    },
  } });
  const children = new Set<ReturnType<typeof spawn>>();
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await closed; } finally { clearTimeout(deadline); children.delete(child); }
  };
  const close = async () => {
    try { await Promise.all([...children].map(stop)); }
    finally {
      backend.closeAllConnections();
      try {
        if (backend.listening) await new Promise<void>((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
      } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  };
  try {
    backend.listen(0, "127.0.0.1"); await once(backend, "listening");
    const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const databaseUrl = new URL(database.connectionString);
    databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
    const identity = createHash("sha256").update(JSON.stringify([backendUrl, teamToken])).digest("hex");
    const persisted = new IntegrationContextStore(pool, "workspace", identity);
    const start = async (workspaceId = "workspace") => {
      // Explicit environment and bare Node: never load application .env files or provider credentials.
      const child = spawn(process.execPath, [fileURLToPath(new URL("../../../server.js", import.meta.url))], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { PATH: process.env.PATH, PORT: "0", DATA_DIR: dataDir, VERIFICATION_MODE: "real",
          VERIFICATION_DATABASE_URL: databaseUrl.href, VERIFICATION_WORKSPACE_ID: workspaceId,
          VERIFICATION_BACKEND_URL: backendUrl, VERIFICATION_BACKEND_TOKEN: teamToken },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      try {
        const url = await new Promise<string>((resolve, reject) => {
          let output = "";
          const deadline = setTimeout(() => finish(new Error("Root startup timed out")), 10000);
          const finish = (error?: Error, value?: string) => {
            clearTimeout(deadline);
            child.off("error", failed); child.off("exit", exited); child.stdout!.off("data", data);
            if (error) reject(error); else resolve(value!);
          };
          const failed = () => finish(new Error("Root process could not start"));
          const exited = () => finish(new Error("Root exited before listening"));
          const data = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4000);
            const port = /Relay listening on port (\d+)/.exec(output)?.[1];
            if (port) finish(undefined, `http://127.0.0.1:${port}`);
          };
          child.on("error", failed); child.on("exit", exited); child.stdout!.on("data", data);
          child.stderr!.on("data", () => {});
        });
        return {
          stop: () => stop(child),
          get: (route: string) => fetch(`${url}${route}`, { signal: AbortSignal.timeout(5000) }),
          post: (route: string, body: unknown, key?: string) => fetch(`${url}${route}`, {
            method: "POST", signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
            body: JSON.stringify(body),
          }),
          async context(): Promise<BrowserSnapshot> {
            const response = await fetch(`${url}/api/verification/context`, { signal: AbortSignal.timeout(5000) });
            expect(response.status).toBe(200);
            const snapshot = await response.json() as BrowserSnapshot;
            for (const record of snapshot.runs) expect(record).not.toHaveProperty("upstreamKey");
            return snapshot;
          },
        };
      } catch (error) { await stop(child); throw error; }
    };
    return { jobs, start, close, persisted, submittedKeys,
      failStatus: (value: boolean) => { statusUnavailable = value; },
      dropNextAcknowledgement: () => { dropAcknowledgement = true; } };
  } catch (error) { await close(); throw error; }
}
beforeAll(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE integration_contexts, integration_workspaces, verification_runs CASCADE"); });
afterAll(async () => {
  try { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { try { await admin.end(); } finally { await database.close(); } }
});

it("upgrades an existing 001 database without changing or losing accepted runs", async () => {
  const upgradeSchema = `upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
  const upgrade = new pg.Pool({ connectionString: database.connectionString, options: `-c search_path=${upgradeSchema}` });
  try {
    await upgrade.query(await readFile(new URL("../../migrations/001_verification.sql", import.meta.url), "utf8"));
    await upgrade.query("CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
    await upgrade.query("INSERT INTO schema_migrations(version) VALUES ('001_verification')");
    const jobs = new JobStore(upgrade, projects);
    const runId = await jobs.enqueue(submission);
    await Promise.all([migrate(upgrade), migrate(upgrade)]);
    expect(await jobs.getRun(runId)).toMatchObject({ ...submission, runId, state: "queued" });
    expect((await upgrade.query("SELECT version FROM schema_migrations ORDER BY version")).rows)
      .toEqual([{ version: "001_verification" }, { version: "002_integration_context" }]);
    expect((await new IntegrationContextStore(upgrade, "workspace", "backend").begin(randomUUID(), submission, context)).revision).toBe(1);
  } finally { await upgrade.end(); await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`); }
});

it("persists immutable context/upstream keys across retries and reconnect, scoped by both identities", async () => {
  const key = randomUUID();
  const first = await store().begin(key, submission, context);
  expect(first).toMatchObject({ requestKey: key, runId: null, status: null, revision: 1 });
  expect(await store().begin(key, submission, { ...context, contractSnapshot: { version: 2 } })).toEqual(first);
  await expect(store().begin(key, { ...submission, commitSha: "12345678".repeat(5) }, context)).rejects.toBeInstanceOf(IntegrationConflictError);
  const reader = createPool();
  try { expect(await new IntegrationContextStore(reader, "workspace", "backend").getByKey(key)).toEqual(first); }
  finally { await reader.end(); }
  for (const [workspace, backend] of [["other", "backend"], ["workspace", "other"]]) {
    const isolated = new IntegrationContextStore(pool, workspace, backend);
    expect(await isolated.getByKey(key)).toBeNull();
    const other = await isolated.begin(key, submission, context);
    expect(other.upstreamKey).not.toBe(first.upstreamKey);
    expect(other.revision).toBe(1);
  }
  expect(await store().snapshot()).toEqual({ revision: 1, runs: [first] });
});

it("serializes concurrent begin and acceptance with collision fencing and durable revisions", async () => {
  const key = randomUUID();
  const records = await Promise.all(Array.from({ length: 12 }, () => store().begin(key, submission, context)));
  expect(new Set(records.map((record) => record.upstreamKey)).size).toBe(1);
  expect((await store().snapshot()).revision).toBe(1);
  const runId = randomUUID();
  const accepted = await store().accept(key, runId);
  expect(accepted.revision).toBe(2);
  expect(await store().accept(key, runId)).toEqual(accepted);
  expect(await store().getByRun(runId)).toEqual(accepted);
  await expect(store().accept(key, randomUUID())).rejects.toBeInstanceOf(IntegrationConflictError);
  const secondKey = randomUUID();
  await store().begin(secondKey, submission, context);
  await expect(store().accept(secondKey, runId)).rejects.toBeInstanceOf(IntegrationConflictError);
  expect((await store().listRecent()).map((record) => record.requestKey)).toEqual([secondKey, key]);
  expect(await store().listPending(1)).toHaveLength(1);
});

it("recovers oldest pending intents first and rotates bounded batches past unchanged failures", async () => {
  const contexts = store();
  const keys: string[] = [];
  for (let index = 0; index < 105; index++) {
    const key = randomUUID(); keys.push(key); await contexts.begin(key, submission, context);
  }
  expect((await contexts.listPending()).map((record) => record.requestKey)).toEqual(keys.slice(0, 100));
  const next = await contexts.listPending();
  expect(next.slice(0, 5).map((record) => record.requestKey)).toEqual(keys.slice(100));
  expect(next).toHaveLength(100);
  expect((await contexts.snapshot()).revision).toBe(105);
  expect((await contexts.listRecent(1))[0].requestKey).toBe(keys[104]);
  expect((await store().listPending(1))[0].requestKey).toBe(keys[0]);
});

it("bumps only changed status, orders progress monotonically and fences both terminal states", async () => {
  for (const state of ["completed", "error"] as const) {
    const key = randomUUID(); const runId = randomUUID();
    await store().begin(key, submission, context); await store().accept(key, runId);
    const base = { ...submission, runId, evidenceRefs: [] };
    const verifying = await store().updateStatus(key, { ...base, state: "verifying" });
    expect(await store().updateStatus(key, { ...base, state: "verifying" })).toEqual(verifying);
    expect(await store().updateStatus(key, { ...base, state: "queued" })).toEqual(verifying);
    const terminal = await store().updateStatus(key, state === "completed"
      ? { ...base, state, outcome: "passed" } : { ...base, state, errorCode: "timeout" });
    expect(terminal.revision).toBe(verifying.revision + 1);
    expect(await store().updateStatus(key, { ...base, state: "preparing" })).toEqual(terminal);
    expect(await store().updateStatus(key, { ...base, state: "completed", outcome: "failed" })).toEqual(terminal);
    await expect(store().updateStatus(key, { ...base, runId: randomUUID(), state: "queued" })).rejects.toBeInstanceOf(IntegrationConflictError);
  }
  expect(await store().listPending()).toEqual([]);
  const snapshot = await store().snapshot();
  expect(snapshot.revision).toBe(8);
  expect(snapshot.runs.map((run) => run.context)).toEqual([context, context]);
});

it("preserves append-only evidence across delayed equal-state responses and rejects changed kinds", async () => {
  const contexts = store(); const key = randomUUID(); const runId = randomUUID();
  await contexts.begin(key, submission, context); await contexts.accept(key, runId);
  const first = { id: randomUUID(), kind: "log" as const };
  const second = { id: randomUUID(), kind: "screenshot" as const };
  const base = { ...submission, runId, state: "verifying" as const };
  const observed = await contexts.updateStatus(key, { ...base, evidenceRefs: [first] });
  expect(await contexts.updateStatus(key, { ...base, evidenceRefs: [] })).toEqual(observed);
  const appended = await contexts.updateStatus(key, { ...base, evidenceRefs: [second] });
  expect(appended.status?.evidenceRefs).toEqual([first, second]);
  expect(appended.revision).toBe(observed.revision + 1);
  expect(await contexts.updateStatus(key, { ...base, evidenceRefs: [first] })).toEqual(appended);
  expect(await contexts.updateStatus(key, { ...base, evidenceRefs: [second, first] })).toEqual(appended);
  await expect(contexts.updateStatus(key, { ...base, evidenceRefs: [{ ...first, kind: "network" }] }))
    .rejects.toBeInstanceOf(IntegrationConflictError);
  expect(await contexts.getByKey(key)).toEqual(appended);
  expect((await contexts.snapshot()).revision).toBe(appended.revision);
});

it.each(["completed", "error"] as const)("preserves observed evidence through higher states and %s transitions", async (state) => {
  const contexts = store(); const key = randomUUID(); const runId = randomUUID();
  await contexts.begin(key, submission, context); await contexts.accept(key, runId);
  const first = { id: randomUUID(), kind: "log" as const };
  const second = { id: randomUUID(), kind: "screenshot" as const };
  const base = { ...submission, runId };
  await contexts.updateStatus(key, { ...base, state: "preparing", evidenceRefs: [first] });
  const verifying = await contexts.updateStatus(key, { ...base, state: "verifying", evidenceRefs: [] });
  expect(verifying.status?.evidenceRefs).toEqual([first]);
  const result = state === "completed" ? { ...base, state, outcome: "passed" as const, evidenceRefs: [second] }
    : { ...base, state, errorCode: "timeout" as const, evidenceRefs: [second] };
  await expect(contexts.updateStatus(key, { ...result, evidenceRefs: [{ ...first, kind: "network" }] }))
    .rejects.toBeInstanceOf(IntegrationConflictError);
  expect((await contexts.snapshot()).revision).toBe(verifying.revision);
  const terminal = await contexts.updateStatus(key, result);
  expect(terminal.status?.evidenceRefs).toEqual([first, second]);
  expect(terminal.revision).toBe(verifying.revision + 1);
  expect(await contexts.updateStatus(key, { ...result, evidenceRefs: [] })).toEqual(terminal);
  expect((await contexts.snapshot()).revision).toBe(terminal.revision);
});

it("atomically reserves idempotency keys under concurrent enqueue and rejects mismatched payloads", async () => {
  const jobs = new JobStore(pool, projects); const key = randomUUID();
  const ids = await Promise.all(Array.from({ length: 12 }, () => jobs.enqueue(submission, key)));
  expect(new Set(ids).size).toBe(1);
  expect((await pool.query("SELECT * FROM verification_jobs")).rows).toHaveLength(1);
  await expect(jobs.enqueue({ ...submission, commitSha: "12345678".repeat(5) }, key)).rejects.toBeInstanceOf(SubmissionConflictError);
  const claim = (await jobs.claim())!;
  await jobs.markVerifying(claim); await jobs.finish(claim, { state: "completed", outcome: "passed" });
  expect(await createRunStore(jobs).createAndEnqueue(submission, key)).toMatchObject({ runId: ids[0], state: "completed" });
});

it("rolls back key reservation with failed enqueue, allowing a safe retry", async () => {
  const jobs = new JobStore(pool, projects); const key = randomUUID();
  await pool.query("ALTER TABLE verification_jobs ADD CONSTRAINT reject_jobs CHECK (false) NOT VALID");
  try {
    await expect(jobs.enqueue(submission, key)).rejects.toThrow();
    expect((await pool.query("SELECT * FROM submission_keys")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM verification_runs")).rows).toEqual([]);
  } finally { await pool.query("ALTER TABLE verification_jobs DROP CONSTRAINT reject_jobs"); }
  expect(await jobs.enqueue(submission, key)).toEqual(expect.any(String));
});

it("recovers a lost HTTP acknowledgement after committed enqueue without duplicating a run/job", async () => {
  const jobs = new JobStore(pool, projects); const durable = createRunStore(jobs);
  const teamToken = "synthetic-demo-team-token-32-characters";
  let drop = true;
  const server = createApiServer({ teamToken, projects, runStore: {
    async createAndEnqueue(input, key) {
      const result = await durable.createAndEnqueue(input, key);
      if (drop) { drop = false; server.closeAllConnections(); }
      return result;
    }, getRun: durable.getRun,
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/submissions`;
  const key = randomUUID();
  const headers = { Authorization: `Bearer ${teamToken}`, "Content-Type": "application/json", "Idempotency-Key": key };
  const post = (body = submission) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    await expect(post()).rejects.toThrow();
    const response = await post(); expect(response.status).toBe(202);
    const { runId } = await response.json() as { runId: string };
    expect((await pool.query("SELECT id FROM verification_runs")).rows).toEqual([{ id: runId }]);
    expect((await pool.query("SELECT run_id FROM verification_jobs")).rows).toEqual([{ run_id: runId }]);
    const claim = (await jobs.claim())!;
    await jobs.finish(claim, { state: "error", errorCode: "environment" });
    const retry = await post(); expect(retry.status).toBe(202); expect(await retry.json()).toEqual({ runId });
    const conflict = await post({ ...submission, commitSha: "12345678".repeat(5) });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "Idempotency key conflict" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("spawned root preserves original context across restart, polls real jobs, and survives status outages", async () => {
  const harness = await rootHarness();
  try {
    let root = await harness.start();
    const key = randomUUID();
    const initialState = await (await root.get("/api/state")).json() as {
      contractVersion: number; assignment: string; requirements: unknown[];
    };
    expect((await root.post("/api/verification/submissions", pinnedSubmission)).status).toBe(400);
    const response = await root.post("/api/verification/submissions", pinnedSubmission, key);
    expect(response.status).toBe(202);
    const { runId } = await response.json() as { runId: string };
    const original = (await root.context()).runs[0];
    expect(original).toMatchObject({ requestKey: key, runId, submission: pinnedSubmission,
      context: { sender: "Aryan", recipient: "Noel", contractSnapshot: {
        contractVersion: initialState.contractVersion, assignment: initialState.assignment,
        requirements: initialState.requirements,
      } } });
    const changed = await root.post("/api/contract", { contractVersion: initialState.contractVersion,
      assignment: "Changed after acceptance", requirements: initialState.requirements });
    expect(changed.status).toBe(200);
    await changed.arrayBuffer();
    await root.stop();
    root = await harness.start();
    // A fresh browser connection reconstructs context from Postgres, not process memory.
    expect((await root.context()).runs[0]).toMatchObject({ runId, context: original.context });
    expect(await (await root.get("/api/state")).json()).toMatchObject({ assignment: "Changed after acceptance" });
    const retry = await root.post("/api/verification/submissions", pinnedSubmission, key);
    expect(retry.status).toBe(202); expect(await retry.json()).toEqual({ runId });
    expect((await root.context()).runs[0].context).toEqual(original.context);
    expect((await pool.query("SELECT id FROM verification_runs")).rows).toEqual([{ id: runId }]);
    expect((await pool.query("SELECT run_id FROM verification_jobs")).rows).toEqual([{ run_id: runId }]);
    const alternate = Object.values(manifest.revisions).find((sha) => sha !== pinnedSubmission.commitSha)!;
    expect(alternate).toBeTruthy();
    const mismatch = await root.post("/api/verification/submissions", { ...pinnedSubmission, commitSha: alternate }, key);
    expect(mismatch.status).toBe(409); await mismatch.arrayBuffer();
    const claim = (await harness.jobs.claim())!;
    expect(claim.runId).toBe(runId);
    await vi.waitFor(async () => {
      expect((await root.context()).runs[0].status?.state).toBe("preparing");
    }, { timeout: 10000, interval: 100 });
    const known = await root.context();
    harness.failStatus(true);
    await harness.jobs.markVerifying(claim);
    const unavailable = await root.get(`/api/verification/runs/${runId}`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ statusUnavailable: true });
    expect(await root.context()).toEqual(known);
    expect((await harness.persisted.getByRun(runId))?.status?.state).toBe("preparing");
    harness.failStatus(false);
    await vi.waitFor(async () => {
      expect((await root.context()).runs[0].status?.state).toBe("verifying");
    }, { timeout: 10000, interval: 100 });
    await harness.jobs.finish(claim, { state: "completed", outcome: "passed" });
    await vi.waitFor(async () => {
      expect((await root.context()).runs[0].status).toMatchObject({ runId, state: "completed", outcome: "passed" });
    }, { timeout: 10000, interval: 100 });
    const terminal = await root.context();
    expect(terminal.revision).toBeGreaterThan(known.revision);
    await root.stop();
    root = await harness.start();
    expect(await root.context()).toEqual(terminal);
    const terminalRetry = await root.post("/api/verification/submissions", pinnedSubmission, key);
    expect(terminalRetry.status).toBe(202); expect(await terminalRetry.json()).toEqual({ runId });
    await root.stop();
    root = await harness.start("other-workspace");
    expect((await root.context()).runs).toEqual([]);
    const foreign = await root.get(`/api/verification/runs/${runId}`);
    expect(foreign.status).toBe(404); await foreign.arrayBuffer();
    expect((await root.context()).runs).toEqual([]);
    expect((await pool.query("SELECT run_id FROM verification_jobs")).rows).toEqual([{ run_id: runId }]);
  } finally { await harness.close(); }
}, 40000);

it("spawned root restarts after lost acceptance and background recovery reuses the persisted upstream key", async () => {
  const harness = await rootHarness();
  try {
    let root = await harness.start();
    const key = randomUUID();
    harness.dropNextAcknowledgement();
    const response = await root.post("/api/verification/submissions", pinnedSubmission, key);
    expect(response.status).toBe(503);
    await response.arrayBuffer();
    // Stop before the one-second recovery tick; acceptance is still unknown to this root process.
    await root.stop();
    const pending = await harness.persisted.getByKey(key);
    expect(pending).toMatchObject({ requestKey: key, runId: null, status: null });
    expect(harness.submittedKeys).toEqual([pending!.upstreamKey]);
    const committed = (await pool.query("SELECT id FROM verification_runs")).rows;
    expect(committed).toHaveLength(1);
    const runId = committed[0].id as string;
    root = await harness.start();
    // No browser resubmission: startup/background recovery alone reconciles the pending intent.
    await vi.waitFor(async () => {
      expect((await root.context()).runs[0]).toMatchObject({ requestKey: key, runId,
        context: pending!.context, status: { state: "queued" } });
    }, { timeout: 10000, interval: 100 });
    expect(harness.submittedKeys).toEqual([pending!.upstreamKey, pending!.upstreamKey]);
    expect((await pool.query("SELECT id FROM verification_runs")).rows).toEqual([{ id: runId }]);
    expect((await pool.query("SELECT run_id FROM verification_jobs")).rows).toEqual([{ run_id: runId }]);
    expect((await pool.query("SELECT key, run_id FROM submission_keys")).rows)
      .toEqual([{ key: pending!.upstreamKey, run_id: runId }]);
    const accepted = await harness.persisted.getByKey(key);
    expect(accepted).toMatchObject({ upstreamKey: pending!.upstreamKey, context: pending!.context, runId });
    const retry = await root.post("/api/verification/submissions", pinnedSubmission, key);
    expect(retry.status).toBe(202); expect(await retry.json()).toEqual({ runId });
    // Reconnect once more to prove the reconciled result survives process death too.
    const snapshot = await root.context();
    await root.stop(); root = await harness.start();
    expect(await root.context()).toEqual(snapshot);
  } finally { await harness.close(); }
}, 30000);
