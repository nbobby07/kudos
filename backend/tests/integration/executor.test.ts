import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createFreestyleExecutor } from "../../src/executor.js";
import { EvidenceStorage } from "../../src/evidence-storage.js";
import type { JobStore } from "../../src/jobs.js";
import { supportedProjects } from "../../src/projects.js";

const exec = promisify(execFile);
const project = supportedProjects[0]!;

describe("production executor SDK boundary (not live Freestyle)", () => {
  it.each(["failed", "passed", "startup-error", "sha-mismatch", "install-error"] as const)("%s transfers exact Git objects and preserves lifecycle", async (scenario) => {
    const directory = await mkdtemp("/tmp/opencode/executor-test-");
    const sha = project.revisions![scenario === "failed" ? 0 : 1]!;
    const claim = { jobId: randomUUID(), runId: randomUUID(), token: randomUUID() };
    const jobs = {
      getRun: vi.fn(async () => ({ projectId: project.id, commitSha: sha })),
      markVerifying: vi.fn(async () => {}),
      addEvidence: vi.fn(async () => {}),
    };
    const storage = new EvidenceStorage(`${directory}/evidence`);
    const result = { requirementId: "declined-payment-retry", state: "completed", outcome: scenario };
    const vm = {
      id: "sdk-boundary-vm",
      exec: vi.fn(async (options: { command: string; stdin?: string }) => {
        if (options.command === "cat > /tmp/verification.bundle") {
          const bundle = `${directory}/fixture.bundle`;
          await writeFile(bundle, Buffer.from(options.stdin!, "base64"));
          const checkout = `${directory}/checkout`;
          await mkdir(checkout);
          await exec("git", ["init"], { cwd: checkout });
          await exec("git", ["bundle", "verify", bundle], { cwd: checkout });
          await exec("git", ["fetch", bundle, sha], { cwd: checkout });
          await exec("git", ["checkout", "--detach", sha], { cwd: checkout });
          expect((await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim()).toBe(sha);
          expect(await readFile(`${checkout}/server.js`, "utf8")).toContain("createServer");
        }
        if (options.command.includes("tar -xzf")) {
          const archive = `${directory}/runner.tar.gz`;
          await writeFile(archive, Buffer.from(options.stdin!, "base64"));
          const entries = (await exec("tar", ["-tzf", archive])).stdout;
          expect(entries).toContain("dist/checkout-runner.js");
          expect(entries).not.toMatch(/\.env|node_modules/);
        }
        if (options.command.includes("rev-parse")) return { statusCode: 0, stdout: scenario === "sha-mismatch" ? "a".repeat(40) : sha };
        if (options.command.includes("curl --")) return { statusCode: 0, stdout: scenario === "startup-error" ? "startup-exited" : "200" };
        if (options.command.includes("npm ci") && scenario === "install-error") return { statusCode: 1, stdout: "" };
        return { statusCode: 0, stdout: "" };
      }),
      fs: { readFile: vi.fn(async (path: string) => {
        if (path.endsWith("result.json")) return Buffer.from(JSON.stringify(result));
        if (path.endsWith("network.json")) return Buffer.from(JSON.stringify([{ attempt: 1, method: "POST", path: "/checkout", status: 402 }]));
        if (path.endsWith("logs.json")) return Buffer.from(JSON.stringify([{ event: "requirement-failed", step: "declined-error" }]));
        if (path.endsWith("failure.png") && scenario === "failed") return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        throw new Error("No screenshot");
      }) },
      delete: vi.fn(async () => {
        // Evidence metadata and durable bytes must exist before VM deletion.
        const metadata = jobs.addEvidence.mock.calls as unknown as [unknown, { storageKey: string }][];
        for (const [, artifact] of metadata) expect((await storage.get(artifact.storageKey)).length).toBeGreaterThan(0);
      }),
    };
    const client = { vms: { create: vi.fn(async () => ({ vm })) } };
    try {
      const terminal = await createFreestyleExecutor(jobs as unknown as JobStore, storage, client)(claim, new AbortController().signal);
      if (scenario === "failed" || scenario === "passed") {
        // JobStore.finish accepts only terminal fields, not the guest requirement/artifact map.
        expect(terminal).toEqual({ state: "completed", outcome: scenario });
        expect(jobs.markVerifying).toHaveBeenCalledWith(claim);
      } else {
        expect(terminal).toEqual({ state: "error", errorCode: scenario === "install-error" ? "tooling" : "environment" });
        expect(jobs.markVerifying).not.toHaveBeenCalled();
      }
      expect(vm.delete).toHaveBeenCalledOnce();
      expect(client.vms.create).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: "freestyle/ubuntu-sm", maxRunSeconds: 640 }));
      const metadata = jobs.addEvidence.mock.calls as unknown as [unknown, { storageKey: string }][];
      for (const [, artifact] of metadata) expect((await storage.get(artifact.storageKey)).length).toBeGreaterThan(0);
      expect(metadata.length).toBe(scenario === "failed" ? 3 : 2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
