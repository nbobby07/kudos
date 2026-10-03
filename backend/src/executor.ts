import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EnvironmentError, withFreestyleApp } from "./freestyle.js";
import { verifyCheckoutInFreestyle } from "./verification.js";
import type { EvidenceStore } from "./evidence-storage.js";
import type { JobExecutor } from "./job-worker.js";
import type { JobStore } from "./jobs.js";
import { supportedProjects } from "./projects.js";

const exec = promisify(execFile);

export function createFreestyleExecutor(jobs: JobStore, storage: EvidenceStore,
  client?: Parameters<typeof withFreestyleApp>[0]["client"]): JobExecutor {
  return async (claim, signal) => {
    const directory = await mkdtemp(join(tmpdir(), "verification-transfer-"));
    try {
      const run = await jobs.getRun(claim.runId);
      const project = supportedProjects.find((project) => project.id === run?.projectId);
      if (!run || !project?.repositoryPath || !project.revisions?.includes(run.commitSha.toLowerCase())) {
        throw new EnvironmentError("environment", "Unsupported fixture revision");
      }
      // Bundle real Git objects and refs, not an archive with a claimed SHA.
      const bundle = join(directory, "fixture.bundle");
      await exec("git", ["bundle", "create", bundle, "--all"], { cwd: project.repositoryPath, signal, timeout: 10_000 });
      const archive = join(directory, "runner.tar.gz");
      const backend = fileURLToPath(new URL("../", import.meta.url));
      await exec("tar", ["-czf", archive, "dist/checkout.js", "dist/checkout-runner.js", "package.json", "package-lock.json"], {
        cwd: backend, signal, timeout: 10_000,
      });
      return await verifyCheckoutInFreestyle({ project, commitSha: run.commitSha, snapshotId: "freestyle/ubuntu-sm",
        port: 3000, readinessPath: "/", repositoryBundle: await readFile(bundle), signal, client, runId: claim.runId,
        runBudgetMs: 600_000, commandTimeoutMs: 300_000, evidenceTimeoutMs: 30_000,
        claim, jobs, storage, runnerCommand: "node /tmp/verification-runner/dist/checkout-runner.js",
        prepareRunner: async (vm, guestSignal, deadline) => {
          const runner = await readFile(archive);
          if (runner.length > 1024 * 1024) throw new EnvironmentError("tooling", "Runner exceeds transfer limit");
          const uploaded = await vm.exec({ command: "mkdir -p /tmp/verification-runner && tar -xzf - -C /tmp/verification-runner",
            stdin: runner.toString("base64"), timeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())) });
          guestSignal.throwIfAborted();
          if (uploaded.statusCode !== 0) throw new EnvironmentError("tooling", "Runner transfer failed");
          const installed = await vm.exec({ command: "cd /tmp/verification-runner && npm ci --omit=dev --ignore-scripts && npx playwright install --with-deps chromium",
            timeoutMs: Math.max(1, Math.min(300_000, deadline - Date.now())), env: { CI: "1" } });
          guestSignal.throwIfAborted();
          if (installed.statusCode !== 0) throw new EnvironmentError("tooling", "Browser toolchain installation failed");
        },
      });
    } catch (error) {
      return { state: "error", errorCode: signal.aborted ? "interrupted" : error instanceof EnvironmentError ? error.code : "tooling" };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
