import { execFile } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { testDatabase } from "./test-database.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
    callback(new Error("synthetic-sensitive-command-text"));
  }),
}));
beforeEach(() => vi.clearAllMocks());

it("uses an explicitly supplied test database without starting or deleting infrastructure", async () => {
  const connectionString = "postgresql://test.invalid/disposable";
  const database = await testDatabase({ TEST_DATABASE_URL: connectionString });
  expect(database.connectionString).toBe(connectionString);
  await database.close();
  expect(execFile).not.toHaveBeenCalled();
});

it("never falls back to the application's database or exposes child-process errors", async () => {
  const applicationDatabase = "postgresql://production.invalid/do-not-touch";
  await expect(testDatabase({ DATABASE_URL: applicationDatabase })).rejects.toThrow(
    "Cannot start disposable verification Postgres. Enable Docker or explicitly supply TEST_DATABASE_URL for a disposable database.",
  );
  expect(JSON.stringify(vi.mocked(execFile).mock.calls)).not.toContain(applicationDatabase);
  expect(vi.mocked(execFile).mock.calls[0]?.[1]).toContain("run");
  expect(vi.mocked(execFile).mock.calls[1]?.[1]).toContain("rm");
});
