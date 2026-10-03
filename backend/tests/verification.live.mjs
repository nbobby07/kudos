import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { Freestyle, FreestyleApiError } from "freestyle";
import { migrate } from "../dist/database.js";
import { JobStore } from "../dist/jobs.js";
import { EvidenceStorage } from "../dist/evidence-storage.js";
import { createRunStore } from "../dist/run-store.js";
import { createApiServer } from "../dist/server.js";

// Opt-in only. Never substitute local execution or skip missing credentials.
if (!process.env.FREESTYLE_API_KEY?.trim()) throw new Error("Live verification requires an authorized server-side FREESTYLE_API_KEY");
if (!process.env.TEST_DATABASE_URL) throw new Error("Live verification requires TEST_DATABASE_URL pointing to disposable Postgres");
const backend = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../../fixtures/checkout-revisions.json", import.meta.url), "utf8"));
const freestyle = new Freestyle();
const token = "synthetic-live-verification-team-token";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

for (const scenario of ["broken", "fixed", "startup-error"]) {
  test(`live standalone worker: ${scenario}`, { timeout: 680_000 }, async () => {
    const schema = `live_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: connection.href });
    const directory = await mkdtemp("/tmp/opencode/live-verification-");
    let server, worker, runId;
    let startupExited = false;
    const storage = new EvidenceStorage(`${directory}/evidence`);
    const jobs = new JobStore(pool);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      // Isolated server-owned config induces a real startup exit, without modifying Git
      // or exposing a request-controlled command/failure switch in the production worker.
      await mkdir(`${directory}/backend`);
      await mkdir(`${directory}/fixtures`);
      await cp(`${backend}/dist`, `${directory}/backend/dist`, { recursive: true });
      await cp(`${backend}/package.json`, `${directory}/backend/package.json`);
      await cp(`${backend}/package-lock.json`, `${directory}/backend/package-lock.json`);
      await symlink(`${backend}/node_modules`, `${directory}/backend/node_modules`, "dir");
      await symlink(fileURLToPath(new URL("../../fixtures/checkout", import.meta.url)), `${directory}/fixtures/checkout`, "dir");
      await writeFile(`${directory}/fixtures/checkout-revisions.json`, JSON.stringify({ ...manifest,
        ...(scenario === "startup-error" ? { startCommand: "node -e 'process.exit(23)'" } : {}) }));
      server = createApiServer({ teamToken: token, runStore: createRunStore(jobs), evidenceStore: {
        getEvidence: (id, evidenceId) => jobs.getEvidence(id, evidenceId), read: (key) => storage.get(key),
      } });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `http://127.0.0.1:${server.address().port}`;
      const commitSha = manifest.revisions[scenario === "broken" ? "broken" : "fixed"];
      const submission = { projectId: manifest.projectId, commitSha, requirementId: "declined-payment-retry" };
      const accepted = await fetch(`${url}/submissions`, { method: "POST", headers, body: JSON.stringify(submission) });
      assert.equal(accepted.status, 202);
      ({ runId } = await accepted.json());
      assert.equal((await jobs.getRun(runId)).state, "queued");
      worker = spawn(process.execPath, ["dist/worker.js"], { cwd: `${directory}/backend`,
        env: { ...process.env, DATABASE_URL: connection.href, DEMO_TEAM_TOKEN: token, EVIDENCE_DIRECTORY: storage.directory },
        stdio: ["ignore", "pipe", "ignore"] });
      worker.stdout.setEncoding("utf8");
      let workerOutput = "";
      worker.stdout.on("data", (chunk) => {
        workerOutput = (workerOutput + chunk).slice(-1024);
        startupExited ||= workerOutput.includes("application-startup-exited");
      });
      const deadline = Date.now() + 650_000;
      let report;
      while (Date.now() < deadline) {
        assert.equal(worker.exitCode, null, "Standalone worker exited before a terminal report");
        report = await (await fetch(`${url}/runs/${runId}`, { headers })).json();
        if (["completed", "error"].includes(report.state)) break;
        await delay(500);
      }
      assert.equal(report.commitSha, commitSha);
      if (scenario === "startup-error") {
        assert.equal(report.state, "error");
        assert.equal(report.errorCode, "environment");
        assert.ok(!("outcome" in report));
        assert.ok(startupExited, "Require a real startup exit, not an unrelated provisioning/transport error");
      } else {
        assert.equal(report.state, "completed");
        assert.equal(report.outcome, scenario === "broken" ? "failed" : "passed");
        if (scenario === "broken") assert.deepEqual(new Set(report.evidenceRefs.map((ref) => ref.kind)), new Set(["screenshot", "network", "log"]));
      }
      // Require provider-confirmed deletion; transport/auth failures are not absence.
      let deleted = false;
      try { await freestyle.vms.get(`verification-${runId}`); }
      catch (error) {
        if (error instanceof FreestyleApiError && error.status === 404) deleted = true;
        else throw new Error("Provider VM lookup failed; deletion is unverified");
      }
      assert.ok(deleted, "VM must be deleted before evidence downloads");
      const reviewDirectory = process.env.LIVE_EVIDENCE_DIRECTORY
        ? resolve(process.env.LIVE_EVIDENCE_DIRECTORY, runId) : undefined;
      if (reviewDirectory) await mkdir(reviewDirectory, { recursive: true, mode: 0o700 });
      if (scenario === "fixed") assert.deepEqual(new Set(report.evidenceRefs.map((ref) => ref.kind)), new Set(["network", "log"]));
      for (const ref of report.evidenceRefs) {
        const path = `${url}/runs/${runId}/evidence/${ref.id}`;
        assert.equal((await fetch(path)).status, 401);
        const downloaded = await fetch(path, { headers });
        assert.equal(downloaded.status, 200);
        const bytes = Buffer.from(await downloaded.arrayBuffer());
        if (ref.kind === "screenshot") assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        else {
          const json = JSON.parse(bytes.toString("utf8"));
          assert.ok(Array.isArray(json));
           if (ref.kind === "network") assert.equal(json.length, scenario === "fixed" ? 2 : 1);
          if (ref.kind === "log" && scenario === "broken") assert.ok(json.some((event) => event.event === "requirement-failed"));
        }
        if (reviewDirectory) await writeFile(`${reviewDirectory}/${ref.id}.${ref.kind === "screenshot" ? "png" : "json"}`, bytes, { mode: 0o600 });
      }
      if (reviewDirectory) await writeFile(`${reviewDirectory}/report.json`, JSON.stringify({ scenario, ...report, vmDeleted: true }, null, 2), { mode: 0o600 });
      assert.equal((await pool.query("SELECT state FROM verification_jobs WHERE run_id = $1", [runId])).rows[0].state, "finished");
      console.info(JSON.stringify({ scenario, runId, commitSha, state: report.state, outcome: report.outcome,
        errorCode: report.errorCode, evidenceKinds: report.evidenceRefs.map((ref) => ref.kind), vmDeleted: true }));
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, "exit");
        worker.kill("SIGTERM");
        await Promise.race([exited, delay(45_000, undefined, { ref: false })]);
        if (worker.exitCode === null && worker.signalCode === null) { worker.kill("SIGKILL"); await exited; }
      }
      let cleanupFailed = false;
      if (runId) {
        try { await freestyle.vms.delete(`verification-${runId}`); }
        catch (error) { cleanupFailed = !(error instanceof FreestyleApiError && error.status === 404); }
      }
      if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
      if (cleanupFailed) throw new Error(`Live verification VM cleanup failed; inspect verification-${runId}`);
    }
  });
}
