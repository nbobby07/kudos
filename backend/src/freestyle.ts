import { Freestyle, type CreateVmOptions, type Vm } from "freestyle";
import type { TrustedProject } from "./projects.js";
import { commitShaSchema } from "./submission.js";

export type ExecutionVm = Pick<Vm, "id" | "exec" | "delete"> & { fs: Pick<Vm["fs"], "readFile"> };
type Client = { vms: { create(options: CreateVmOptions): Promise<{ vm: ExecutionVm }> } };
export class EnvironmentError extends Error {
  constructor(public readonly code: "environment" | "tooling" | "timeout", message: string) {
    super(message);
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Server-owned configuration only. Collection finishes or times out before VM deletion. */
export async function withFreestyleApp<T>(
  options: {
    project: TrustedProject;
    commitSha: string;
    snapshotId: string;
    port: number;
    readinessPath: string;
    runBudgetMs?: number;
    commandTimeoutMs?: number;
    readinessTimeoutMs?: number;
    evidenceTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    onDiagnostic?: (event: "evidence-collection-failed" | "vm-cleanup-failed") => void;
    client?: Client;
    repositoryBundle?: Uint8Array;
    signal?: AbortSignal;
    runId?: string;
  },
  check: (environment: { vm: ExecutionVm; appUrl: string; commitSha: string; signal: AbortSignal; deadline: number }) => Promise<T>,
  collect?: (environment: { vm: ExecutionVm; signal: AbortSignal; result: T | undefined; error: unknown }) => Promise<void>,
): Promise<T> {
  const sha = commitShaSchema.parse(options.commitSha).toLowerCase();
  const repository = new URL(options.project.repositoryUrl);
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.search || repository.hash) {
    throw new EnvironmentError("environment", "A public HTTPS repository without credentials is required");
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 ||
      !/^\/[a-zA-Z0-9/_-]*$/.test(options.readinessPath)) {
    throw new EnvironmentError("environment", "Invalid readiness configuration");
  }
  const budget = options.runBudgetMs ?? 600_000;
  const commandTimeout = options.commandTimeoutMs ?? 120_000;
  const readinessTimeout = options.readinessTimeoutMs ?? 30_000;
  const evidenceTimeout = options.evidenceTimeoutMs ?? 10_000;
  const cleanupTimeout = options.cleanupTimeoutMs ?? 10_000;
  for (const value of [budget, commandTimeout, readinessTimeout, evidenceTimeout, cleanupTimeout]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 900_000) {
      throw new EnvironmentError("environment", "Deadlines must be between 1ms and 15 minutes");
    }
  }
  const client = options.client ?? new Freestyle();
  const controller = new AbortController();
  options.signal?.throwIfAborted();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = Date.now() + budget;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let vm: ExecutionVm | undefined;
  let primaryError: unknown;
  let primaryResult: T | undefined;
  const diagnose = (event: "evidence-collection-failed" | "vm-cleanup-failed") => {
    try {
      if (options.onDiagnostic) options.onDiagnostic(event);
      else console.error(event);
    } catch { /* Diagnostic sinks must not replace the primary result. */ }
  };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EnvironmentError("timeout", "Verification run budget exceeded"));
      controller.abort();
    }, budget);
  });
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new EnvironmentError("environment", "Verification interrupted")), { once: true });
  });
  const bounded = <R>(operation: Promise<R>) => Promise.race([operation, timeout, interrupted]);
  const appUrl = `http://127.0.0.1:${options.port}`;
  const creation = Promise.resolve().then(() => client.vms.create({
    snapshotId: options.snapshotId,
    ...(options.runId ? { slug: `verification-${options.runId}` } : {}),
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    ttlSeconds: Math.ceil((budget + evidenceTimeout + cleanupTimeout) / 1000) + 60,
    maxRunSeconds: Math.ceil((budget + evidenceTimeout + cleanupTimeout) / 1000),
    maxRunTotalSeconds: Math.ceil((budget + evidenceTimeout + cleanupTimeout) / 1000),
  })).catch(() => {
    throw new EnvironmentError("environment", "VM creation failed");
  }).then(async ({ vm: created }) => {
    // A timed-out create can still finish remotely. Reclaim its eventual handle.
    if (controller.signal.aborted) {
      await created.delete();
      throw new EnvironmentError("timeout", "VM creation exceeded run budget");
    }
    vm = created;
    return created;
  });
  try {
    const machine = await bounded(creation);
    const exec = async (command: string, code: "environment" | "tooling" = "environment", limit = commandTimeout) => {
      controller.signal.throwIfAborted();
      const result = await bounded(machine.exec({
        command,
        timeoutMs: Math.max(1, Math.min(limit, commandTimeout, deadline - Date.now(), 300_000)),
        env: { CI: "1", NODE_ENV: "test", PORT: String(options.port), HOST: "127.0.0.1" },
      }).catch(() => {
        throw new EnvironmentError("environment", "VM execution transport failed");
      }));
      if (result.statusCode !== 0) {
        // Do not expose command output: dependency/app logs may contain secrets.
        throw new EnvironmentError(result.statusCode == null ? "timeout" : code, "VM command failed");
      }
      return result.stdout?.trim() ?? "";
    };
    await exec("command -v git && command -v node && command -v npm && command -v curl", "tooling");
    if (options.repositoryBundle) {
      if (options.repositoryBundle.length > 1024 * 1024) throw new EnvironmentError("environment", "Fixture bundle exceeds transfer limit");
      const transfer = await bounded(machine.exec({ command: "cat > /tmp/verification.bundle", stdin: Buffer.from(options.repositoryBundle).toString("base64"), timeoutMs: Math.min(commandTimeout, 300_000) }));
      if (transfer.statusCode !== 0) throw new EnvironmentError("environment", "Fixture transfer failed");
      await exec(`mkdir -p /tmp/verification-app && cd /tmp/verification-app && git init && git bundle verify /tmp/verification.bundle && git fetch /tmp/verification.bundle ${sha} && git checkout --detach ${sha}`);
    } else {
      await exec(`mkdir -p /tmp/verification-app && cd /tmp/verification-app && git init && git remote add origin ${quote(repository.href)} && git -c protocol.file.allow=never fetch --depth=1 origin ${sha} && git checkout --detach ${sha}`);
    }
    const actualSha = await exec("cd /tmp/verification-app && git rev-parse HEAD");
    if (actualSha !== sha) throw new EnvironmentError("environment", "Checked-out revision does not match submission");
    await exec(`cd /tmp/verification-app && ${options.project.setupCommand}`);
    await exec(`cd /tmp/verification-app && nohup sh -c ${quote(`${options.project.startCommand}; status=$?; echo "$status" > /tmp/verification-app.exit`)} > /tmp/verification-app.log 2>&1 < /dev/null &`);
    const readyUntil = Math.min(deadline, Date.now() + readinessTimeout);
    let ready = false;
    while (Date.now() < readyUntil) {
      const status = await exec(`if test -f /tmp/verification-app.exit; then echo startup-exited; else curl --max-time 1 --silent --output /dev/null --write-out '%{http_code}' ${quote(appUrl + options.readinessPath)} || true; fi`, "environment", Math.min(2000, readyUntil - Date.now()));
      if (status === "startup-exited") {
        console.info("application-startup-exited");
        throw new EnvironmentError("environment", "Application exited before readiness");
      }
      if (/^2\d\d$/.test(status)) { ready = true; break; }
      await bounded(new Promise((resolve) => setTimeout(resolve, 100)));
    }
    if (!ready) throw new EnvironmentError("timeout", "Application readiness deadline exceeded");
    primaryResult = await bounded(check({ vm: machine, appUrl, commitSha: sha, signal: controller.signal, deadline }));
    return primaryResult;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", onAbort);
    if (vm) {
      if (collect) {
        const collection = new AbortController();
        let collectionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            collect({ vm, signal: collection.signal, result: primaryResult, error: primaryError }),
            new Promise<never>((_, reject) => {
              collectionTimer = setTimeout(() => {
                collection.abort();
                reject(new Error("Evidence collection deadline exceeded"));
              }, evidenceTimeout);
            }),
          ]);
        } catch { diagnose("evidence-collection-failed"); }
        finally {
          if (collectionTimer) clearTimeout(collectionTimer);
          collection.abort();
        }
      }
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          vm.delete(),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new EnvironmentError("environment", "VM cleanup deadline exceeded")), cleanupTimeout);
          }),
        ]);
      } catch {
        diagnose("vm-cleanup-failed");
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    }
  }
}
