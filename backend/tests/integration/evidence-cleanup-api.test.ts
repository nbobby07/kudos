import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvidenceStorage, MAX_EVIDENCE_BYTES } from "../../src/evidence-storage.js";
import type { EvidenceMetadata } from "../../src/jobs.js";
import { createApiServer } from "../../src/server.js";

const teamToken = "synthetic-demo-team-token-32-characters";
const headers = { Authorization: `Bearer ${teamToken}` };
const runId = randomUUID();
const evidenceId = randomUUID();
const storageKey = randomUUID();
const png = Buffer.from("89504e470d0a1a0a", "hex");
let directory: string;
let storage: EvidenceStorage;
let metadata: EvidenceMetadata;
let server: ReturnType<typeof createApiServer>;
let url: string;
const getEvidence = vi.fn(async (run: string, id: string): Promise<EvidenceMetadata | null> =>
  run === runId && id === evidenceId ? metadata : null);
const read = vi.fn(async (key: string) => storage.get(key));

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "evidence-api-"));
  storage = new EvidenceStorage(join(directory, "private"));
  metadata = { id: evidenceId, storageKey, kind: "screenshot", contentType: "image/png", byteSize: png.length };
  await storage.put(storageKey, png);
  server = createApiServer({ teamToken, evidenceStore: { getEvidence, read } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

const download = (run: string = runId, id: string = evidenceId) => fetch(`${url}/runs/${run}/evidence/${id}`, { headers });

it("persists only UUID filenames with private permissions, survives reopening, and deletes idempotently", async () => {
  expect((await stat(storage.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(storage.directory, storageKey))).mode & 0o777).toBe(0o600);
  expect(await readdir(storage.directory)).toEqual([storageKey]);
  const reopened = new EvidenceStorage(storage.directory);
  expect(await reopened.get(storageKey)).toEqual(png);
  await reopened.delete(storageKey);
  await reopened.delete(storageKey);
  await expect(reopened.get(storageKey)).rejects.toThrow();
  expect(await readdir(storage.directory)).toEqual([]);
});

it("rejects traversal and oversized artifacts without leaving temporary files", async () => {
  for (const key of ["../outside", "/tmp/outside", `${storageKey}/../outside`, "not-a-uuid"]) {
    await expect(storage.put(key, png)).rejects.toThrow("Invalid evidence storage key");
    await expect(storage.get(key)).rejects.toThrow("Invalid evidence storage key");
    await expect(storage.delete(key)).rejects.toThrow("Invalid evidence storage key");
  }
  await expect(storage.put(randomUUID(), Buffer.alloc(MAX_EVIDENCE_BYTES + 1))).rejects.toThrow("Invalid evidence size");
  expect(await readdir(storage.directory)).toEqual([storageKey]);
});

it("refuses symlink reads and oversized on-disk files", async () => {
  const key = randomUUID();
  await symlink(join(storage.directory, storageKey), join(storage.directory, key));
  await expect(storage.get(key)).rejects.toThrow();
  await storage.delete(key);
  await writeFile(join(storage.directory, key), Buffer.alloc(MAX_EVIDENCE_BYTES + 1));
  await expect(storage.get(key)).rejects.toThrow("Invalid evidence file");
});

it("authenticates before metadata lookup, storage reads, or ID validation", async () => {
  for (const authorization of [undefined, "Bearer incorrect"]) {
    const response = await fetch(`${url}/runs/malformed/evidence/..%2Fsecret`, {
      headers: authorization ? { Authorization: authorization } : {},
    });
    expect(response.status).toBe(401);
  }
  expect(getEvidence).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("rejects malformed IDs before storage access", async () => {
  for (const [run, id] of [["invalid", evidenceId], [runId, "invalid"], [runId, "..%2Fsecret"]]) {
    expect((await download(run, id)).status).toBe(400);
  }
  expect(getEvidence).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("does not read unknown evidence or evidence belonging to another run", async () => {
  for (const [run, id] of [[randomUUID(), evidenceId], [runId, randomUUID()]]) {
    const response = await download(run, id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Evidence not found" });
    expect(getEvidence).toHaveBeenLastCalledWith(run, id);
  }
  expect(read).not.toHaveBeenCalled();
});

it("serves authorized PNG and JSON bytes with safe headers and no storage key", async () => {
  for (const kind of ["screenshot", "log", "network"] as const) {
    const bytes = kind === "screenshot" ? png : Buffer.from('{"events":[]}');
    metadata = { ...metadata, kind, contentType: kind === "screenshot" ? "image/png" : "application/json", byteSize: bytes.length };
    await storage.put(storageKey, bytes);
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(metadata.contentType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(JSON.stringify([...response.headers])).not.toContain(storageKey);
    expect(read).toHaveBeenLastCalledWith(storageKey);
  }
});

it("fails closed on invalid metadata without reading files or exposing paths", async () => {
  const original = metadata;
  for (const change of [
    { id: randomUUID() }, { storageKey: "../private/secret" }, { contentType: "text/html" },
    { kind: "log" as const }, { byteSize: MAX_EVIDENCE_BYTES + 1 }, { byteSize: -1 },
  ]) {
    metadata = { ...original, ...change };
    const response = await download();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Evidence service unavailable" });
  }
  expect(read).not.toHaveBeenCalled();
});

it("returns safe errors for unavailable or size-mismatched bytes", async () => {
  metadata.byteSize++;
  let response = await download();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Evidence service unavailable" });
  metadata.byteSize--;
  await storage.delete(storageKey);
  response = await download();
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toBe('{"error":"Evidence service unavailable"}');
  expect(body).not.toContain(directory);
  expect(body).not.toContain(storageKey);
});
