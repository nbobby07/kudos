import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistGuestEvidence, readCheckoutReport } from "../../src/evidence.js";
import { EvidenceStorage, MAX_EVIDENCE_BYTES } from "../../src/evidence-storage.js";
import { withFreestyleApp } from "../../src/freestyle.js";
import type { EvidenceMetadata, JobClaim } from "../../src/jobs.js";
import { verifyCheckoutInFreestyle } from "../../src/verification.js";

const sha = "a".repeat(40);
const png = Buffer.from("89504e470d0a1a0a", "hex");
const network = [{ attempt: 1, method: "POST", path: "/checkout", status: 402 }];
const logs = [{ event: "check-interrupted", step: "retry" }];
const report = { requirementId: "declined-payment-retry", state: "completed", outcome: "passed" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
let directory: string;
let storage: EvidenceStorage;

beforeEach(async () => {
  directory = await mkdtemp("/tmp/opencode/evidence-cleanup-");
  storage = new EvidenceStorage(directory);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const files = new Map<string, Uint8Array>([
    ["network.json", encode(network)], ["logs.json", encode(logs)],
    ["failure.png", png], ["result.json", encode(report)],
  ]);
  const events: string[] = [];
  let deleted = false;
  const vm = {
    id: "evidence-test-vm",
    fs: { readFile: vi.fn(async (path: string, _options?: { length?: number; signal?: AbortSignal }) => {
      if (deleted) throw new Error("VM already deleted");
      const name = path.replace("/tmp/verification-evidence/", "");
      const bytes = files.get(name);
      if (!bytes) throw new Error("Missing guest artifact");
      events.push(`read:${name}`);
      return new Uint8Array(bytes);
    }) },
    exec: vi.fn(async ({ command }: { command: string }) => ({
      statusCode: 0,
      stdout: command.includes("rev-parse HEAD") ? sha : command.includes("curl --") ? "200" : "",
    })),
    delete: vi.fn(async () => { events.push("delete"); deleted = true; files.clear(); }),
  };
  const claim: JobClaim = { jobId: randomUUID(), runId: randomUUID(), token: randomUUID() };
  const metadata: EvidenceMetadata[] = [];
  const jobs = { addEvidence: vi.fn(async (inputClaim: JobClaim, evidence: EvidenceMetadata) => {
    expect(inputClaim).toBe(claim);
    expect(vm.delete).not.toHaveBeenCalled();
    expect(await storage.get(evidence.storageKey)).toHaveLength(evidence.byteSize);
    events.push(`metadata:${evidence.kind}`);
    metadata.push(evidence);
  }) };
  const onDiagnostic = vi.fn();
  const options = {
    project: { id: "checkout", repositoryUrl: "https://github.com/demo/checkout.git", setupCommand: "npm ci", startCommand: "npm start" },
    commitSha: sha, snapshotId: "trusted-node-snapshot", port: 3000, readinessPath: "/health",
    runBudgetMs: 1000, evidenceTimeoutMs: 1000, cleanupTimeoutMs: 25, onDiagnostic,
    client: { vms: { create: vi.fn(async () => ({ vm })) } },
  };
  const persist = (signal: AbortSignal) => persistGuestEvidence({ vm, signal, claim, jobs, storage, onDiagnostic });
  return { vm, files, events, claim, metadata, jobs, options, onDiagnostic, persist };
}

describe("evidence collection and VM cleanup", () => {
  it.each(["passed", "failed"] as const)("executor persists evidence before deleting and returns %s", async (outcome) => {
    const f = fixture();
    f.files.set("result.json", encode({ ...report, outcome }));
    const markVerifying = vi.fn(async () => {});
    await expect(verifyCheckoutInFreestyle({ ...f.options, claim: f.claim,
      jobs: { ...f.jobs, markVerifying }, storage })).resolves.toEqual({ state: "completed", outcome });
    expect(markVerifying).toHaveBeenCalledExactlyOnceWith(f.claim);
    expect(f.vm.exec).toHaveBeenCalledWith(expect.objectContaining({
      command: "node /opt/verifier/dist/checkout-runner.js /tmp/verification-evidence",
      env: { APP_URL: "http://127.0.0.1:3000", CI: "1", NODE_ENV: "test" },
    }));
    expect(f.events.at(-1)).toBe("delete");
    for (const artifact of f.metadata) expect(await storage.get(artifact.id)).toHaveLength(artifact.byteSize);
  });

  it("executor never invents a product outcome without a valid primary report", async () => {
    const f = fixture();
    f.files.delete("result.json");
    await expect(verifyCheckoutInFreestyle({ ...f.options, claim: f.claim,
      jobs: { ...f.jobs, markVerifying: vi.fn(async () => {}) }, storage })).resolves.toEqual({ state: "error", errorCode: "tooling" });
    expect(f.metadata).toHaveLength(3);
    expect(f.events.at(-1)).toBe("delete");
  });

  it.each(["passed", "failed"] as const)("preserves a %s primary outcome and durable evidence after deletion", async (outcome) => {
    const f = fixture();
    f.files.set("result.json", encode({ ...report, outcome }));
    let primarySignal: AbortSignal | undefined;
    const collect = vi.fn(async ({ signal, result, error }) => {
      expect(primarySignal?.aborted).toBe(true);
      expect(signal).not.toBe(primarySignal);
      expect(signal.aborted).toBe(false);
      expect(result).toEqual({ ...report, outcome });
      expect(error).toBeUndefined();
      expect(f.vm.delete).not.toHaveBeenCalled();
      await f.persist(signal);
    });
    await expect(withFreestyleApp(f.options, async ({ vm, signal }) => {
      primarySignal = signal;
      return readCheckoutReport(vm, signal);
    }, collect)).resolves.toEqual({ ...report, outcome });
    expect(collect).toHaveBeenCalledOnce();
    expect(f.events).toEqual([
      "read:result.json", "read:network.json", "metadata:network", "read:logs.json", "metadata:log",
      "read:failure.png", "metadata:screenshot", "delete",
    ]);
    expect(f.vm.delete).toHaveBeenCalledOnce();
    expect(f.files.size).toBe(0);
    expect(f.metadata.map(({ kind }) => kind)).toEqual(["network", "log", "screenshot"]);
    const reopened = new EvidenceStorage(directory);
    for (const evidence of f.metadata) {
      const bytes = await reopened.get(evidence.storageKey);
      expect(evidence.storageKey).toBe(evidence.id);
      expect(bytes).toEqual(evidence.kind === "screenshot" ? png : encode(evidence.kind === "network" ? network : logs));
      expect(evidence.contentType).toBe(evidence.kind === "screenshot" ? "image/png" : "application/json");
    }
    expect((await readdir(directory)).sort()).toEqual(f.metadata.map(({ id }) => id).sort());
    expect(f.onDiagnostic).not.toHaveBeenCalled();
  });

  it("uses a fresh finalizer signal to transfer partial network/logs and preserves the timeout", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.files.delete("failure.png");
    let primarySignal: AbortSignal | undefined;
    let finalizerSignal: AbortSignal | undefined;
    let primaryError: unknown;
    const run = withFreestyleApp({ ...f.options, runBudgetMs: 25 }, async ({ signal }) => {
      primarySignal = signal;
      return new Promise<never>(() => {});
    }, async ({ signal, result, error }) => {
      finalizerSignal = signal;
      primaryError = error;
      expect(primarySignal?.aborted).toBe(true);
      expect(signal).not.toBe(primarySignal);
      expect(signal.aborted).toBe(false);
      expect(result).toBeUndefined();
      await f.persist(signal);
    });
    const assertion = expect(run).rejects.toMatchObject({ code: "timeout", message: "Verification run budget exceeded" });
    await vi.advanceTimersByTimeAsync(0);
    expect(primarySignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(primaryError).toMatchObject({ code: "timeout" });
    expect(finalizerSignal?.aborted).toBe(true);
    expect(f.metadata.map(({ kind }) => kind)).toEqual(["network", "log"]);
    expect(f.events.at(-1)).toBe("delete");
    expect(f.vm.delete).toHaveBeenCalledOnce();
    for (const evidence of f.metadata) expect(await storage.get(evidence.id)).toHaveLength(evidence.byteSize);
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("evidence-artifact-unavailable");
  });

  it("removes an uploaded orphan when fenced metadata registration fails and continues", async () => {
    const f = fixture();
    f.jobs.addEvidence.mockRejectedValueOnce(new Error("Claim expired"));
    const remove = vi.spyOn(storage, "delete");
    const refs = await f.persist(new AbortController().signal);
    const orphan = f.jobs.addEvidence.mock.calls[0]![1];
    expect(remove).toHaveBeenCalledExactlyOnceWith(orphan.id);
    await expect(storage.get(orphan.id)).rejects.toMatchObject({ code: "ENOENT" });
    expect(refs.map(({ kind }) => kind)).toEqual(["log", "screenshot"]);
    expect((await readdir(directory)).sort()).toEqual(refs.map(({ id }) => id).sort());
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("evidence-artifact-unavailable");
  });

  it("continues uploading other artifacts after one upload fails", async () => {
    const f = fixture();
    const put = vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("Upload unavailable"));
    const refs = await f.persist(new AbortController().signal);
    expect(put).toHaveBeenCalledTimes(3);
    expect(refs.map(({ kind }) => kind)).toEqual(["log", "screenshot"]);
    expect(f.jobs.addEvidence).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).not.toContain(put.mock.calls[0]![0]);
    for (const { id } of refs) await expect(storage.get(id)).resolves.toBeInstanceOf(Buffer);
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("evidence-artifact-unavailable");
  });

  it.each(["extra fields", "invalid JSON"])("rejects secret-bearing network/log %s without raw leaks", async (malformation) => {
    const f = fixture();
    const secret = "synthetic-secret-must-never-leak";
    f.files.set("network.json", malformation === "extra fields" ? encode([{ ...network[0], authorization: secret }]) : Buffer.from(`{${secret}`));
    f.files.set("logs.json", malformation === "extra fields" ? encode([{ ...logs[0], message: secret }]) : Buffer.from(`{${secret}`));
    const put = vi.spyOn(storage, "put");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const refs = await f.persist(new AbortController().signal);
    expect(refs.map(({ kind }) => kind)).toEqual(["screenshot"]);
    expect(put).toHaveBeenCalledExactlyOnceWith(refs[0]!.id, png);
    expect(f.onDiagnostic.mock.calls).toEqual([["evidence-artifact-unavailable"], ["evidence-artifact-unavailable"]]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(JSON.stringify({ refs, metadata: f.metadata, diagnostics: f.onDiagnostic.mock.calls })).not.toContain(secret);
    expect(await readdir(directory)).toEqual([refs[0]!.id]);
    expect(await storage.get(refs[0]!.id)).toEqual(png);
  });

  it("bounds a hanging collector, aborts it, then deletes without changing the primary result", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal: AbortSignal | undefined;
    const run = withFreestyleApp({ ...f.options, evidenceTimeoutMs: 25 }, async () => report, async (environment) => {
      signal = environment.signal;
      return new Promise<void>(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    expect(f.vm.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    await expect(run).resolves.toBe(report);
    expect(signal?.aborted).toBe(true);
    expect(f.vm.delete).toHaveBeenCalledOnce();
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("evidence-collection-failed");
  });

  it.each(["throw", "hang"] as const)("preserves a primary error when collection %s fails", async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    const primary = new Error("Primary check failure");
    const run = withFreestyleApp({ ...f.options, evidenceTimeoutMs: 25 }, async () => { throw primary; }, async () => {
      if (mode === "throw") throw new Error("Collection failure");
      return new Promise<void>(() => {});
    });
    const assertion = expect(run).rejects.toBe(primary);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(f.vm.delete).toHaveBeenCalledOnce();
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("evidence-collection-failed");
  });

  it.each([
    ["throw", "passed"], ["hang", "passed"], ["throw", "failed"], ["hang", "failed"],
    ["throw", "error"], ["hang", "error"],
  ] as const)("preserves primary %s cleanup / %s outcome and diagnoses even with a throwing sink", async (cleanup, outcome) => {
    vi.useFakeTimers();
    const f = fixture();
    const primary = new Error("Primary check failure");
    const result = { ...report, outcome };
    f.vm.delete.mockImplementation(async () => {
      if (cleanup === "throw") throw new Error("Cleanup failure");
      return new Promise<void>(() => {});
    });
    f.onDiagnostic.mockImplementation(() => { throw new Error("Diagnostic sink failure"); });
    const run = withFreestyleApp(f.options, async () => {
      if (outcome === "error") throw primary;
      return result;
    });
    const assertion = outcome === "error" ? expect(run).rejects.toBe(primary) : expect(run).resolves.toBe(result);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(f.vm.delete).toHaveBeenCalledOnce();
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("vm-cleanup-failed");
  });

  it("does not read, upload, or register metadata with an already aborted signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const put = vi.spyOn(storage, "put");
    await expect(f.persist(controller.signal)).resolves.toEqual([]);
    expect(f.vm.fs.readFile).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(f.jobs.addEvidence).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["read", "upload"] as const)("prevents late metadata after a hanging %s outlives collection and VM deletion", async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const put = vi.spyOn(storage, "put");
    if (stage === "read") {
      f.vm.fs.readFile.mockImplementationOnce(async () => { await gate; return new Uint8Array(encode(network)); });
    } else {
      put.mockImplementationOnce(async (key, bytes) => { await gate; await new EvidenceStorage(directory).put(key, bytes); });
    }
    let collection: ReturnType<typeof f.persist> | undefined;
    const run = withFreestyleApp({ ...f.options, evidenceTimeoutMs: 25 }, async () => report, async ({ signal }) => {
      collection = f.persist(signal);
      await collection;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(collection).toBeDefined();
    await vi.advanceTimersByTimeAsync(25);
    await expect(run).resolves.toBe(report);
    expect(f.vm.delete).toHaveBeenCalledOnce();
    release();
    await expect(collection!).resolves.toEqual([]);
    expect(f.jobs.addEvidence).not.toHaveBeenCalled();
    expect(f.vm.fs.readFile).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledTimes(stage === "read" ? 0 : 1);
    expect(await readdir(directory)).toEqual([]);
    expect(f.onDiagnostic.mock.calls).toEqual([["evidence-collection-failed"], ["evidence-artifact-unavailable"]]);
  });
});

describe("readCheckoutReport", () => {
  it.each([
    report, { ...report, outcome: "failed" },
    ...["environment", "tooling", "timeout", "interrupted"].map((errorCode) => ({
      requirementId: "declined-payment-retry", state: "error", errorCode,
    })),
  ])("accepts the terminal report schema: %j", async (terminal) => {
    const f = fixture();
    f.files.set("result.json", encode(terminal));
    const signal = new AbortController().signal;
    await expect(readCheckoutReport(f.vm, signal)).resolves.toEqual(terminal);
    expect(f.vm.fs.readFile).toHaveBeenCalledExactlyOnceWith("/tmp/verification-evidence/result.json", { length: 16_385, signal });
  });

  it("accepts exactly the size limit and rejects the limit plus one", async () => {
    const f = fixture();
    f.files.set("result.json", Buffer.from(JSON.stringify(report).padEnd(16_384, " ")));
    await expect(readCheckoutReport(f.vm, new AbortController().signal)).resolves.toEqual(report);
    f.files.set("result.json", Buffer.from(JSON.stringify(report).padEnd(16_385, " ")));
    await expect(readCheckoutReport(f.vm, new AbortController().signal)).rejects.toThrow("Guest report too large");
  });

  it.each([
    Buffer.from("not JSON"), Buffer.from([0xff]), encode({ ...report, requirementId: "unknown" }),
    encode({ ...report, outcome: "unverified" }), encode({ ...report, state: "running" }),
    encode({ requirementId: "declined-payment-retry", state: "completed" }),
    encode({ requirementId: "declined-payment-retry", state: "error", errorCode: "unknown" }),
  ])("rejects malformed report bytes/schema %#", async (bytes) => {
    const f = fixture();
    f.files.set("result.json", bytes);
    await expect(readCheckoutReport(f.vm, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects a report read that completes after abort", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.vm.fs.readFile.mockImplementationOnce(async () => { controller.abort(); return new Uint8Array(encode(report)); });
    await expect(readCheckoutReport(f.vm, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["network.json", "logs.json", "failure.png"])("rejects oversized %s and continues other artifacts", async (name) => {
    const f = fixture();
    f.files.set(name, new Uint8Array(MAX_EVIDENCE_BYTES + 1));
    const refs = await f.persist(new AbortController().signal);
    expect(refs).toHaveLength(2);
    expect(f.onDiagnostic).toHaveBeenCalledExactlyOnceWith("evidence-artifact-unavailable");
    expect(f.vm.fs.readFile.mock.calls.map(([path, options]) => [path, options?.length])).toEqual([
      ["/tmp/verification-evidence/network.json", MAX_EVIDENCE_BYTES + 1],
      ["/tmp/verification-evidence/logs.json", MAX_EVIDENCE_BYTES + 1],
      ["/tmp/verification-evidence/failure.png", MAX_EVIDENCE_BYTES + 1],
    ]);
    expect((await readdir(directory)).sort()).toEqual(refs.map(({ id }) => id).sort());
  });
});
