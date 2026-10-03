import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkCheckout } from "../../src/checkout.js";

const repository = fileURLToPath(new URL("../../../fixtures/checkout", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("../../../fixtures/checkout-revisions.json", import.meta.url), "utf8"));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function startFixture(sha: string) {
  const directory = await mkdtemp("/tmp/opencode/checkout-check-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const archive = spawnSync("git", ["archive", "--format=tar", sha], { cwd: repository });
  expect(archive.status).toBe(0);
  const extract = spawnSync("tar", ["-xf", "-", "-C", directory], { input: archive.stdout });
  expect(extract.status).toBe(0);
  const process = spawn(globalThis.process.execPath, ["server.js"], {
    cwd: directory, env: { PATH: globalThis.process.env.PATH, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(async () => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exit = once(process, "exit");
    process.kill("SIGKILL");
    await exit;
  });
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 5000);
    process.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
    process.once("error", (error) => { clearTimeout(timer); reject(error); });
    process.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture exited")); });
  });
}

describe("checkout requirement check", () => {
  it("passes the fixed immutable revision only after two declined POSTs", async () => {
    const result = await checkCheckout({ appUrl: await startFixture(fixture.revisions.fixed), assertionTimeoutMs: 1000 });
    expect(result).toMatchObject({ state: "completed", outcome: "passed", requirementId: "declined-payment-retry" });
    expect(result.evidence.network).toEqual([1, 2].map((attempt) => ({ attempt, method: "POST", path: "/checkout", status: 402 })));
  });

  it("fails the broken immutable revision with screenshot, network, and diagnostic logs", async () => {
    const result = await checkCheckout({ appUrl: await startFixture(fixture.revisions.broken), assertionTimeoutMs: 300 });
    expect(result).toMatchObject({ state: "completed", outcome: "failed" });
    expect(result.evidence.screenshot?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(result.evidence.network).toHaveLength(1);
    expect(result.evidence.logs).toContainEqual({ event: "requirement-failed", step: "declined-error" });
  });

  it("does not pass when retry is visible but sends no second request", async () => {
    const html = await readFile(new URL("../../../fixtures/checkout/index.html", import.meta.url), "utf8");
    let realPayments = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") realPayments++;
      response.end(html.replace("retry.addEventListener('click', pay);", "retry.addEventListener('click', () => {});"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const result = await checkCheckout({ appUrl: `http://127.0.0.1:${address.port}`, assertionTimeoutMs: 300 });
    expect(result).toMatchObject({ state: "completed", outcome: "failed" });
    expect(result.evidence.network).toHaveLength(1);
    expect(result.evidence.screenshot).toBeInstanceOf(Buffer);
    expect(result.evidence.logs).toContainEqual({ event: "requirement-failed", step: "retry" });
    expect(realPayments).toBe(0);
  });

  it("guest runner writes failure artifacts and a structured report before exiting", async () => {
    const appUrl = await startFixture(fixture.revisions.broken);
    const directory = await mkdtemp("/tmp/opencode/checkout-evidence-");
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await promisify(execFile)(process.execPath, ["--import", "tsx", "src/checkout-runner.ts", directory], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, APP_URL: appUrl }, timeout: 15_000,
    });
    const report = JSON.parse(await readFile(`${directory}/result.json`, "utf8"));
    expect(report).toMatchObject({ state: "completed", outcome: "failed", evidence: {
      screenshot: "failure.png", network: "network.json", logs: "logs.json",
    } });
    expect((await readFile(`${directory}/failure.png`)).length).toBeGreaterThan(100);
    expect(JSON.parse(await readFile(`${directory}/network.json`, "utf8"))).toHaveLength(1);
    expect(JSON.parse(await readFile(`${directory}/logs.json`, "utf8"))).toContainEqual({ event: "requirement-failed", step: "declined-error" });
  }, 20_000);

  it("classifies unavailable app as a run error, never a product failure", async () => {
    const result = await checkCheckout({ appUrl: "http://127.0.0.1:1", assertionTimeoutMs: 300 });
    expect(result).toMatchObject({ state: "error", errorCode: "environment" });
  });

  it("guest artifact-write failure cannot erase the primary product result", async () => {
    const appUrl = await startFixture(fixture.revisions.fixed);
    const directory = await mkdtemp("/tmp/opencode/checkout-write-failure-");
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await mkdir(`${directory}/network.json`);
    const execution = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/checkout-runner.ts", directory], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { ...process.env, APP_URL: appUrl }, timeout: 15_000,
    });
    expect(execution.stderr).toContain("primary report preserved");
    expect(JSON.parse(await readFile(`${directory}/result.json`, "utf8"))).toMatchObject({ state: "completed", outcome: "passed" });
    expect(JSON.parse(await readFile(`${directory}/logs.json`, "utf8"))).toContainEqual({ event: "requirement-passed", step: "retry" });
  }, 20_000);

  it("handles cancellation as interruption rather than a pass or product defect", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await checkCheckout({ appUrl: "http://127.0.0.1:3000", signal: controller.signal });
    expect(result).toMatchObject({ state: "error", errorCode: "interrupted" });
  });
});
