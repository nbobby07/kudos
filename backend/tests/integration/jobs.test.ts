import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/database.js";
import { executeNextJob } from "../../src/job-worker.js";
import { JobStore, type JobClaim } from "../../src/jobs.js";
import type { Submission } from "../../src/submission.js";
import { testDatabase } from "../test-database.js";

const database = await testDatabase();
const { connectionString } = database;
const schema = `jobs_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString });
const createPool = () => new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const pool = createPool();
const projects = [{ id: "test-checkout", repositoryUrl: "https://example.invalid/checkout.git",
  setupCommand: "npm ci", startCommand: "npm start" }];
const submission: Submission = { projectId: projects[0].id, commitSha: "abcdef01".repeat(5),
  requirementId: "declined-payment-retry" };
const jobs = new JobStore(pool, projects);
const evidence = () => ({ id: randomUUID(), kind: "log" as const, storageKey: "private/worker/log.txt",
  contentType: "text/plain", byteSize: 42 });

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await Promise.all([migrate(pool), migrate(pool)]);
});
beforeEach(async () => {
  await pool.query("TRUNCATE submission_keys, verification_evidence, verification_jobs, verification_runs");
});
afterAll(async () => {
  try {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    try { await admin.end(); } finally { await database.close(); }
  }
});

it("migrates idempotently and durably enqueues one job per run", async () => {
  await Promise.all([migrate(pool), migrate(pool)]);
  expect((await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows)
    .toEqual([{ version: "001_verification" }, { version: "002_integration_context" }]);
  const runId = await jobs.enqueue(submission);
  const readerPool = createPool();
  try {
    expect(await new JobStore(readerPool, projects).getRun(runId))
      .toEqual({ ...submission, runId, state: "queued", evidenceRefs: [] });
    expect((await readerPool.query("SELECT run_id, state FROM verification_jobs")).rows)
      .toEqual([{ run_id: runId, state: "queued" }]);
    await expect(readerPool.query("INSERT INTO verification_jobs(id, run_id) VALUES ($1, $2)",
      [randomUUID(), runId])).rejects.toMatchObject({ code: "23505" });
    expect((await readerPool.query("SELECT run_id FROM verification_jobs")).rows).toEqual([{ run_id: runId }]);
  } finally {
    await readerPool.end();
  }
});

it("rolls back the run when a job insertion trigger fails", async () => {
  await pool.query(`CREATE FUNCTION reject_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated job insert failure'; END;
  $$`);
  try {
    await pool.query(`CREATE TRIGGER reject_job_insert BEFORE INSERT ON verification_jobs
      FOR EACH ROW EXECUTE FUNCTION reject_job_insert()`);
    await expect(jobs.enqueue(submission)).rejects.toThrow("simulated job insert failure");
    expect((await pool.query("SELECT * FROM verification_runs")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM verification_jobs")).rows).toEqual([]);
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS reject_job_insert ON verification_jobs");
    await pool.query("DROP FUNCTION reject_job_insert()");
  }
});

it("gives exactly one of twelve concurrent claimants a single queued job", async () => {
  const runId = await jobs.enqueue(submission);
  const claims = await Promise.all(Array.from({ length: 12 }, () => jobs.claim()));
  const winners = claims.filter((claim) => claim !== null);
  expect(winners).toHaveLength(1);
  expect(winners[0]?.runId).toBe(runId);
  expect(claims.filter((claim) => claim === null)).toHaveLength(11);
  expect(await jobs.getRun(runId)).toMatchObject({ state: "preparing" });
});

it("claims eight queued jobs concurrently without duplicate jobs, runs, or tokens", async () => {
  const runIds = await Promise.all(Array.from({ length: 8 }, () => jobs.enqueue(submission)));
  const claims = await Promise.all(Array.from({ length: 8 }, () => jobs.claim()));
  expect(claims.every((claim) => claim !== null)).toBe(true);
  const winners = claims.filter((claim) => claim !== null);
  expect(new Set(winners.map((claim) => claim.jobId)).size).toBe(8);
  expect(new Set(winners.map((claim) => claim.token)).size).toBe(8);
  expect(new Set(winners.map((claim) => claim.runId))).toEqual(new Set(runIds));
  expect(await jobs.claim()).toBeNull();
});

it("persists verifying progress and evidence, hides storage keys, and requires verifying before completion", async () => {
  const runId = await jobs.enqueue(submission);
  const claim = (await jobs.claim())!;
  await expect(jobs.finish(claim, { state: "completed", outcome: "passed" }))
    .rejects.toThrow("Run is not ready");
  expect(await jobs.getRun(runId)).toMatchObject({ state: "preparing" });
  expect((await pool.query("SELECT state, claim_token FROM verification_jobs WHERE id = $1", [claim.jobId])).rows)
    .toEqual([{ state: "claimed", claim_token: claim.token }]);
  await jobs.markVerifying(claim);
  expect((await pool.query("SELECT state FROM verification_runs WHERE id = $1", [runId])).rows)
    .toEqual([{ state: "verifying" }]);
  expect(await jobs.getRun(runId)).toMatchObject({ state: "verifying" });
  const metadata = evidence();
  await jobs.addEvidence(claim, metadata);
  expect((await pool.query(`SELECT id, kind, storage_key, content_type, byte_size
    FROM verification_evidence WHERE run_id = $1`, [runId])).rows).toEqual([{
    id: metadata.id, kind: metadata.kind, storage_key: metadata.storageKey,
    content_type: metadata.contentType, byte_size: String(metadata.byteSize),
  }]);
  expect(await jobs.getRun(runId)).toEqual({ ...submission, runId, state: "verifying",
    evidenceRefs: [{ id: metadata.id, kind: metadata.kind }] });
  await jobs.finish(claim, { state: "completed", outcome: "passed" });
  expect(await jobs.getRun(runId)).toEqual({ ...submission, runId, state: "completed", outcome: "passed",
    evidenceRefs: [{ id: metadata.id, kind: metadata.kind }] });
  expect((await pool.query("SELECT state, claim_token, lease_expires_at FROM verification_jobs")).rows)
    .toEqual([{ state: "finished", claim_token: null, lease_expires_at: null }]);
});

it("forbids all claim mutations with a wrong token", async () => {
  const runId = await jobs.enqueue(submission);
  const claim = (await jobs.claim())!;
  const impostor: JobClaim = { ...claim, token: randomUUID() };
  await expect(jobs.heartbeat(impostor)).rejects.toThrow("Job claim lost or expired");
  await expect(jobs.markVerifying(impostor)).rejects.toThrow("Job claim lost or expired");
  await expect(jobs.addEvidence(impostor, evidence())).rejects.toThrow("Job claim lost or expired");
  await expect(jobs.finish(impostor, { state: "error", errorCode: "tooling" }))
    .rejects.toThrow("Job claim lost or expired");
  expect(await jobs.getRun(runId)).toEqual({ ...submission, runId, state: "preparing", evidenceRefs: [] });
  await jobs.heartbeat(claim);
});

it("fences an expired lease and recovers it exactly once without retrying or losing evidence", async () => {
  const runId = await jobs.enqueue(submission);
  const claim = (await jobs.claim())!;
  await jobs.markVerifying(claim);
  const metadata = evidence();
  await jobs.addEvidence(claim, metadata);
  await pool.query("UPDATE verification_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [claim.jobId]);
  await expect(jobs.heartbeat(claim)).rejects.toThrow("Job claim lost or expired");
  await expect(jobs.finish(claim, { state: "completed", outcome: "passed" }))
    .rejects.toThrow("Job claim lost or expired");
  const recovered = await Promise.all(Array.from({ length: 12 }, () => jobs.recoverInterrupted()));
  expect(recovered.filter((count) => count === 1)).toHaveLength(1);
  expect(recovered.filter((count) => count === 0)).toHaveLength(11);
  expect(await jobs.getRun(runId)).toEqual({ ...submission, runId, state: "error", errorCode: "interrupted",
    evidenceRefs: [{ id: metadata.id, kind: metadata.kind }] });
  expect((await pool.query("SELECT storage_key FROM verification_evidence WHERE run_id = $1", [runId])).rows)
    .toEqual([{ storage_key: metadata.storageKey }]);
  expect((await pool.query("SELECT state, claim_token, lease_expires_at FROM verification_jobs")).rows)
    .toEqual([{ state: "finished", claim_token: null, lease_expires_at: null }]);
  expect(await jobs.recoverInterrupted()).toBe(0);
  expect(await jobs.claim()).toBeNull();
  await expect(jobs.finish(claim, { state: "error", errorCode: "tooling" }))
    .rejects.toThrow("Job claim lost or expired");
});

it("extends a live lease with heartbeat and leaves it untouched by recovery", async () => {
  const runId = await jobs.enqueue(submission);
  const claim = (await jobs.claim(30_000))!;
  const before = (await pool.query("SELECT lease_expires_at FROM verification_jobs WHERE id = $1", [claim.jobId]))
    .rows[0].lease_expires_at as Date;
  await jobs.heartbeat(claim, 60_000);
  const after = (await pool.query("SELECT lease_expires_at FROM verification_jobs WHERE id = $1", [claim.jobId]))
    .rows[0].lease_expires_at as Date;
  expect(after.getTime()).toBeGreaterThan(before.getTime());
  expect(await jobs.recoverInterrupted()).toBe(0);
  expect(await jobs.getRun(runId)).toMatchObject({ state: "preparing" });
  await jobs.markVerifying(claim);
  await jobs.finish(claim, { state: "completed", outcome: "passed" });
});

it("executes a durable submission from a different pool after the submitting pool closes", async () => {
  const clientPool = createPool();
  let runId: string;
  try {
    runId = await new JobStore(clientPool, projects).enqueue(submission);
  } finally {
    await clientPool.end();
  }
  const workerPool = createPool();
  const workerStore = new JobStore(workerPool, projects);
  const executed: string[] = [];
  try {
    await executeNextJob(workerStore, async (claim) => {
      executed.push(claim.runId);
      await workerStore.markVerifying(claim);
      return { state: "completed", outcome: "passed" };
    }, new AbortController().signal);
    expect(executed).toEqual([runId]);
    expect(await jobs.getRun(runId)).toMatchObject({ state: "completed", outcome: "passed" });
  } finally {
    await workerPool.end();
  }
});

it("aborts active execution on shutdown and records interrupted rather than passed", async () => {
  const runId = await jobs.enqueue(submission);
  const shutdown = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let executionSignal: AbortSignal | undefined;
  const execution = executeNextJob(jobs, async (claim, signal) => {
    executionSignal = signal;
    await jobs.markVerifying(claim);
    started();
    try {
      await delay(1_000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    // A late successful executor result must not override shutdown.
    return { state: "completed", outcome: "passed" };
  }, shutdown.signal);
  try {
    await Promise.race([ready, execution.then(() => { throw new Error("Worker stopped before executing"); })]);
    shutdown.abort();
    await execution;
    expect(executionSignal?.aborted).toBe(true);
    expect(await jobs.getRun(runId)).toEqual({ ...submission, runId, state: "error",
      errorCode: "interrupted", evidenceRefs: [] });
    expect(await jobs.claim()).toBeNull();
  } finally {
    shutdown.abort();
    await execution;
  }
});

it("renews a 600ms lease while executing for more than 800ms", async () => {
  const runId = await jobs.enqueue(submission);
  const startedAt = Date.now();
  await executeNextJob(jobs, async (claim, signal) => {
    await jobs.markVerifying(claim);
    await delay(800, undefined, { signal });
    expect(await jobs.recoverInterrupted()).toBe(0);
    return { state: "completed", outcome: "passed" };
  }, new AbortController().signal, 600);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);
  expect(await jobs.getRun(runId)).toMatchObject({ state: "completed", outcome: "passed" });
  expect(await jobs.recoverInterrupted()).toBe(0);
});

it("records a tooling error when the executor throws", async () => {
  const runId = await jobs.enqueue(submission);
  await executeNextJob(jobs, async () => {
    throw new Error("simulated executor failure");
  }, new AbortController().signal);
  expect(await jobs.getRun(runId)).toEqual({ ...submission, runId, state: "error",
    errorCode: "tooling", evidenceRefs: [] });
  expect(await jobs.claim()).toBeNull();
});

it("persists interruption even if the executor ignores cancellation", async () => {
  const runId = await jobs.enqueue(submission);
  const shutdown = new AbortController();
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let claim!: JobClaim;
  const execution = executeNextJob(jobs, async (owned) => {
    claim = owned;
    await jobs.markVerifying(claim);
    started();
    await blocked;
    return { state: "completed", outcome: "passed" };
  }, shutdown.signal);
  try {
    await ready;
    shutdown.abort();
    await execution;
    expect(await jobs.getRun(runId)).toMatchObject({ state: "error", errorCode: "interrupted" });
    await expect(jobs.finish(claim, { state: "completed", outcome: "passed" }))
      .rejects.toThrow("Job claim lost or expired");
  } finally {
    release();
    shutdown.abort();
    await execution;
  }
});

it("recovers a crashed worker during preparation while preserving queued work", async () => {
  const runId = await jobs.enqueue(submission);
  const claim = (await jobs.claim())!;
  const queuedId = await jobs.enqueue(submission);
  await pool.query("UPDATE verification_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [claim.jobId]);
  expect(await jobs.recoverInterrupted()).toBe(1);
  expect(await jobs.getRun(runId)).toMatchObject({ state: "error", errorCode: "interrupted" });
  expect(await jobs.getRun(queuedId)).toMatchObject({ state: "queued" });
  expect((await jobs.claim())?.runId).toBe(queuedId);
});
