import { describe, expect, it, vi } from "vitest";
import { withFreestyleApp } from "../../src/freestyle.js";

const sha = "a".repeat(40);
function fixture() {
  const vm = {
    id: "test-vm",
    fs: { readFile: vi.fn(async () => new Uint8Array()) },
    exec: vi.fn(async (options: { command: string }) => ({
      statusCode: 0,
      stdout: options.command.includes("rev-parse") ? sha : options.command.includes("curl --") ? "200" : "",
    })),
    delete: vi.fn(async () => {}),
  };
  const client = { vms: { create: vi.fn(async () => ({ vm })) } };
  const options = {
    project: { id: "checkout", repositoryUrl: "https://github.com/demo/checkout.git", setupCommand: "npm ci", startCommand: "npm start" },
    commitSha: sha.toUpperCase(), snapshotId: "trusted-node-snapshot", port: 3000,
    readinessPath: "/health", client, runBudgetMs: 1000,
  };
  return { vm, client, options };
}

describe("freestyle SDK adapter", () => {
  it("creates a private budgeted VM, checks exact revision, sets up and waits before checking", async () => {
    const { vm, client, options } = fixture();
    const check = vi.fn(async (environment) => {
      expect(environment.commitSha).toBe(sha);
      expect(environment.appUrl).toBe("http://127.0.0.1:3000");
      expect(environment.signal.aborted).toBe(false);
      expect(vm.delete).not.toHaveBeenCalled();
      return "evidence collected";
    });
    expect(await withFreestyleApp(options, check)).toBe("evidence collected");
    expect(client.vms.create).toHaveBeenCalledWith({
      snapshotId: "trusted-node-snapshot", ttlSeconds: 81, maxRunSeconds: 21, maxRunTotalSeconds: 21,
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    });
    const commands = vm.exec.mock.calls.map(([call]) => call.command);
    expect(commands[1]).toContain(`fetch --depth=1 origin ${sha}`);
    expect(commands[2]).toContain("rev-parse HEAD");
    expect(commands[3]).toContain("npm ci");
    expect(commands[4]).toContain("nohup sh -c 'npm start;");
    expect(commands[5]).toContain("http://127.0.0.1:3000/health");
    expect(vm.exec.mock.calls[0]?.[0]).toMatchObject({
      env: { CI: "1", NODE_ENV: "test", PORT: "3000", HOST: "127.0.0.1" }, timeoutMs: expect.any(Number),
    });
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("rejects revision mismatch before executing repository code", async () => {
    const { vm, options } = fixture();
    vm.exec.mockResolvedValueOnce({ statusCode: 0, stdout: "" })
      .mockResolvedValueOnce({ statusCode: 0, stdout: "" })
      .mockResolvedValueOnce({ statusCode: 0, stdout: "b".repeat(40) });
    const check = vi.fn();
    await expect(withFreestyleApp(options, check)).rejects.toMatchObject({ code: "environment" });
    expect(check).not.toHaveBeenCalled();
    expect(vm.exec).toHaveBeenCalledTimes(3);
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("treats nonzero setup exit as environment failure and does not expose logs", async () => {
    const { vm, options } = fixture();
    vm.exec.mockResolvedValueOnce({ statusCode: 0, stdout: "" })
      .mockResolvedValueOnce({ statusCode: 0, stdout: "" })
      .mockResolvedValueOnce({ statusCode: 0, stdout: sha })
      .mockResolvedValueOnce({ statusCode: 1, stdout: "secret-test-value" });
    await expect(withFreestyleApp(options, vi.fn())).rejects.toMatchObject({ code: "environment", message: "VM command failed" });
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("classifies missing snapshot tooling and cleans up", async () => {
    const { vm, options } = fixture();
    vm.exec.mockResolvedValueOnce({ statusCode: 127, stdout: "" });
    await expect(withFreestyleApp(options, vi.fn())).rejects.toMatchObject({ code: "tooling" });
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("sanitizes SDK transport errors and cleans up", async () => {
    const { vm, options } = fixture();
    vm.exec.mockRejectedValueOnce(new Error("transport included secret"));
    await expect(withFreestyleApp(options, vi.fn())).rejects.toMatchObject({ code: "environment", message: "VM execution transport failed" });
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("reports failed provisioning as an environment error", async () => {
    const { client, options } = fixture();
    client.vms.create.mockRejectedValueOnce(new Error("provider failure"));
    await expect(withFreestyleApp(options, vi.fn())).rejects.toMatchObject({ code: "environment", message: "VM creation failed" });
  });

  it("fails readiness without calling the product check", async () => {
    const { vm, options } = fixture();
    vm.exec.mockImplementation(async ({ command }) => ({ statusCode: 0, stdout: command.includes("rev-parse") ? sha : "503" }));
    const check = vi.fn();
    await expect(withFreestyleApp({ ...options, readinessTimeoutMs: 5 }, check)).rejects.toMatchObject({ code: "timeout" });
    expect(check).not.toHaveBeenCalled();
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("classifies an exited startup process as environment failure, not a product outcome", async () => {
    const { vm, options } = fixture();
    vm.exec.mockImplementation(async ({ command }) => ({ statusCode: 0,
      stdout: command.includes("rev-parse") ? sha : command.includes("curl --") ? "startup-exited" : "" }));
    const check = vi.fn();
    await expect(withFreestyleApp(options, check)).rejects.toMatchObject({ code: "environment" });
    expect(check).not.toHaveBeenCalled();
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("collects evidence and deletes the VM on standalone-worker cancellation", async () => {
    const { vm, options } = fixture();
    const shutdown = new AbortController();
    const collect = vi.fn(async () => { expect(vm.delete).not.toHaveBeenCalled(); });
    await expect(withFreestyleApp({ ...options, signal: shutdown.signal }, async () => {
      shutdown.abort();
      return new Promise(() => {});
    }, collect)).rejects.toMatchObject({ code: "environment" });
    expect(collect).toHaveBeenCalledOnce();
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("bounds hanging commands and reclaims the VM", async () => {
    const { vm, options } = fixture();
    vm.exec.mockImplementation(() => new Promise(() => {}));
    await expect(withFreestyleApp({ ...options, runBudgetMs: 10 }, vi.fn())).rejects.toMatchObject({ code: "timeout" });
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it("reclaims a VM returned after the creation deadline", async () => {
    const { vm, client, options } = fixture();
    let resolve!: (value: { vm: typeof vm }) => void;
    client.vms.create.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await expect(withFreestyleApp({ ...options, runBudgetMs: 10 }, vi.fn())).rejects.toMatchObject({ code: "timeout" });
    resolve({ vm });
    await vi.waitFor(() => expect(vm.delete).toHaveBeenCalledOnce());
    expect(vm.exec).not.toHaveBeenCalled();
  });

  it("preserves a check failure even when cleanup fails", async () => {
    const { vm, options } = fixture();
    const error = new Error("check failed");
    vm.delete.mockRejectedValue(new Error("cleanup failed"));
    await expect(withFreestyleApp(options, async () => { throw error; })).rejects.toBe(error);
  });

  it("preserves a successful check and reports cleanup failure separately", async () => {
    const { vm, options } = fixture();
    vm.delete.mockRejectedValue(new Error("cleanup failed"));
    const onDiagnostic = vi.fn();
    await expect(withFreestyleApp({ ...options, onDiagnostic }, async () => "passed")).resolves.toBe("passed");
    expect(onDiagnostic).toHaveBeenCalledWith("vm-cleanup-failed");
  });

  it("aborts and cleans up when a check exceeds the total run budget", async () => {
    const { vm, options } = fixture();
    let signal: AbortSignal | undefined;
    await expect(withFreestyleApp({ ...options, runBudgetMs: 10 }, async (environment) => {
      signal = environment.signal;
      return new Promise(() => {});
    })).rejects.toMatchObject({ code: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(vm.delete).toHaveBeenCalledOnce();
  });

  it.each(["https://user:password@github.com/demo/app", "file:///tmp/app", "https://github.com/app?token=secret"])(
    "rejects credential-bearing or non-HTTPS repositories: %s", async (repositoryUrl) => {
      const { client, options } = fixture();
      await expect(withFreestyleApp({ ...options, project: { ...options.project, repositoryUrl } }, vi.fn())).rejects.toMatchObject({ code: "environment" });
      expect(client.vms.create).not.toHaveBeenCalled();
    },
  );
});
