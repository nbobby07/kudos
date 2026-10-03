import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServer, type RunStore } from "../src/server.js";
import { createRunStore } from "../src/run-store.js";
import type { VerificationResult } from "../src/submission.js";

const teamToken = "synthetic-demo-team-token-32-characters";
const headers = { Authorization: `Bearer ${teamToken}`, "Content-Type": "application/json" };
const projects = [{ id: "test-checkout", repositoryUrl: "https://example.invalid/checkout.git",
  setupCommand: "npm ci", startCommand: "npm start" }];
const submission = { projectId: projects[0].id, commitSha: "abcdef01".repeat(5),
  requirementId: "declined-payment-retry" as const };
const runId = "22222222-2222-4222-8222-222222222222";
const queued: VerificationResult = { ...submission, runId, state: "queued", evidenceRefs: [] };

it("API store adapter uses the transactional job queue and persisted reads", async () => {
  const jobs = { enqueue: vi.fn().mockResolvedValue(runId), getRun: vi.fn().mockResolvedValue(queued) };
  const store = createRunStore(jobs);
  expect(await store.createAndEnqueue(submission)).toEqual(queued);
  expect(jobs.enqueue).toHaveBeenCalledWith(submission);
  expect(jobs.getRun).not.toHaveBeenCalled();
  expect(await store.getRun(runId)).toEqual(queued);
  expect(jobs.getRun).toHaveBeenCalledWith(runId);
  jobs.enqueue.mockRejectedValue(new Error("transaction rolled back"));
  await expect(store.createAndEnqueue(submission)).rejects.toThrow("transaction rolled back");
});

describe("API", () => {
  let server: ReturnType<typeof createApiServer>;
  let url: string;
  let store: RunStore;
  beforeEach(async () => {
    store = { createAndEnqueue: vi.fn().mockResolvedValue(queued), getRun: vi.fn().mockResolvedValue(queued) };
    server = createApiServer({ teamToken, projects, runStore: store });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const post = (url: string, body: unknown = submission) => fetch(`${url}/submissions`, {
    method: "POST", headers, body: JSON.stringify(body),
  });

  it("returns an ID only after durable enqueue resolves, without waiting for verification", async () => {
    let commit!: (result: VerificationResult) => void;
    vi.mocked(store.createAndEnqueue).mockReturnValue(new Promise<VerificationResult>((resolve) => { commit = resolve; }));
    let responded = false;
    const pending = post(url).then((response) => { responded = true; return response; });
    await vi.waitFor(() => expect(store.createAndEnqueue).toHaveBeenCalledWith(submission));
    expect(responded).toBe(false);
    commit(queued);
    const response = await pending;
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/runs/${runId}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ runId });
    expect(store.getRun).not.toHaveBeenCalled();
  });

  it.each([
    queued,
    { ...queued, state: "preparing" },
    { ...queued, state: "verifying" },
    { ...queued, state: "completed", outcome: "failed",
      evidenceRefs: [{ id: runId, kind: "screenshot" }] },
    { ...queued, state: "error", errorCode: "interrupted" },
  ] as VerificationResult[])("retrieves persisted $state progress/results", async (result) => {
    vi.mocked(store.getRun).mockResolvedValue(result);
    const response = await fetch(`${url}/runs/${runId}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(store.getRun).toHaveBeenCalledWith(runId);
    expect(store.createAndEnqueue).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong-token", `Bearer ${"x".repeat(teamToken.length)}`,
    `Basic ${teamToken}`, `Bearer ${teamToken}extra`])(
    "rejects unauthorized submissions and polling before storage or validation", async (authorization) => {
      for (const [path, method] of [["/submissions", "POST"], ["/runs/bad-id", "GET"]]) {
        const response = await fetch(url + path, { method,
          headers: authorization ? { Authorization: authorization } : {},
          ...(method === "POST" ? { body: "not JSON" } : {}),
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
      expect(store.createAndEnqueue).not.toHaveBeenCalled();
      expect(store.getRun).not.toHaveBeenCalled();
    });

  it("rejects duplicate Authorization headers", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/runs/${runId}`, {
        headers: ["Host", new URL(url).host,
          "Authorization", `Bearer ${teamToken}`, "Authorization", `Bearer ${teamToken}`],
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(401);
    expect(store.getRun).not.toHaveBeenCalled();
  });

  it("authenticates before idempotency validation and rejects malformed keys", async () => {
    const unauthorized = await fetch(`${url}/submissions`, { method: "POST",
      headers: { "Idempotency-Key": "invalid" }, body: "invalid" });
    expect(unauthorized.status).toBe(401);
    const malformed = await fetch(`${url}/submissions`, { method: "POST",
      headers: { ...headers, "Idempotency-Key": "invalid" }, body: JSON.stringify(submission) });
    expect(malformed.status).toBe(400);
    expect(store.createAndEnqueue).not.toHaveBeenCalled();
  });

  it("rejects duplicate Idempotency-Key headers even when both values match", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/submissions`, { method: "POST",
        headers: ["Host", new URL(url).host, "Authorization", `Bearer ${teamToken}`,
          "Content-Type", "application/json", "Idempotency-Key", runId, "Idempotency-Key", runId],
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end(JSON.stringify(submission));
    });
    expect(status).toBe(400);
    expect(store.createAndEnqueue).not.toHaveBeenCalled();
  });

  it("forwards keyed submissions and accepts a persisted terminal identity", async () => {
    vi.mocked(store.createAndEnqueue).mockResolvedValue({ ...queued, state: "completed", outcome: "passed" });
    const response = await fetch(`${url}/submissions`, { method: "POST",
      headers: { ...headers, "Idempotency-Key": runId }, body: JSON.stringify(submission) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId });
    expect(store.createAndEnqueue).toHaveBeenCalledWith(submission, runId);
  });

  it.each([
    { ...submission, projectId: "unknown" }, { ...submission, commitSha: "main" },
    { ...submission, commitSha: "0".repeat(40) }, { ...submission, requirementId: "other" },
    { ...submission, command: "touch /tmp/untrusted" },
    { ...submission, repositoryUrl: "https://untrusted.invalid" }, {}, null,
  ])("rejects invalid or request-controlled submission configuration", async (body) => {
    const response = await post(url, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid submission" });
    expect(store.createAndEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain", "{}", 415], ["application/json", "{", 400],
    ["application/json", "x".repeat(16 * 1024 + 1), 413],
  ])("rejects media type, malformed JSON, and oversized bodies", async (contentType, body, status) => {
    const response = await fetch(`${url}/submissions`, { method: "POST",
      headers: { ...headers, "Content-Type": String(contentType) }, body: String(body) });
    expect(response.status).toBe(status);
    expect(store.createAndEnqueue).not.toHaveBeenCalled();
  });

  it("limits streamed bodies without Content-Length", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/submissions`, { method: "POST", headers }, (response) => {
        response.resume(); resolve(response.statusCode);
      });
      request.on("error", reject);
      request.write(" ".repeat(8192));
      request.write(" ".repeat(8192));
      request.end(" ");
    });
    expect(status).toBe(413);
    expect(store.createAndEnqueue).not.toHaveBeenCalled();
  });

  it("distinguishes malformed, missing, and unknown routes and unsupported methods", async () => {
    vi.mocked(store.getRun).mockResolvedValue(null);
    expect((await fetch(`${url}/runs/bad`, { headers })).status).toBe(400);
    expect(store.getRun).not.toHaveBeenCalled();
    expect((await fetch(`${url}/runs/${runId}`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/unknown`, { headers })).status).toBe(404);
    const response = await fetch(`${url}/submissions`, { headers });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("does not accept failed persistence or expose internal errors", async () => {
    vi.mocked(store.createAndEnqueue).mockRejectedValue(new Error(`postgresql://secret ${teamToken}`));
    const response = await post(url);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "Run service unavailable" });
  });

  it("returns a safe service error if persisted progress cannot be read", async () => {
    vi.mocked(store.getRun).mockRejectedValue(new Error(`postgresql://secret ${teamToken}`));
    const response = await fetch(`${url}/runs/${runId}`, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Run service unavailable" });
  });

  it("does not leak invalid persisted records or mismatched run identity", async () => {
    for (const result of [{ ...queued, runId: "11111111-1111-4111-8111-111111111111" },
      { ...queued, credentials: teamToken }]) {
      vi.mocked(store.getRun).mockResolvedValue(result);
      const response = await fetch(`${url}/runs/${runId}`, { headers });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Run service unavailable" });
    }
  });
});
