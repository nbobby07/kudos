import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const valid = {
  DEMO_TEAM_TOKEN: "synthetic-demo-team-token-32-characters",
  DATABASE_URL: "postgresql://user:secret@localhost:5432/handoff",
  FREESTYLE_API_KEY: "test-key",
};

describe("server environment", () => {
  it("validates secrets and applies local API defaults", () => {
    expect(loadEnv(valid)).toEqual({ ...valid, HOST: "127.0.0.1", PORT: 3000,
      EVIDENCE_DIRECTORY: resolve(".data/evidence") });
  });

  it("requires credentials", () => {
    expect(() => loadEnv({})).toThrow("DEMO_TEAM_TOKEN, DATABASE_URL, FREESTYLE_API_KEY");
  });

  it.each(["", "http://localhost/db", "postgresql:///db"])("rejects invalid database URL %s", (url) => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: url })).toThrow("DATABASE_URL");
  });

  it("rejects whitespace-only API keys", () => {
    expect(() => loadEnv({ ...valid, FREESTYLE_API_KEY: "  " })).toThrow("FREESTYLE_API_KEY");
  });

  it.each(["", "short", " ".repeat(32), "a".repeat(257), "a".repeat(32) + "!"])
    ("rejects invalid demo team tokens without disclosing them", (token) => {
      expect(() => loadEnv({ ...valid, DEMO_TEAM_TOKEN: token }))
        .toThrow(/^Invalid server environment: DEMO_TEAM_TOKEN$/);
    });

  it.each(["0", "65536", "3.5", "not-a-port", ""])("rejects invalid port %s", (port) => {
    expect(() => loadEnv({ ...valid, PORT: port })).toThrow("PORT");
  });

  it("does not expose credentials in validation errors", () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: "invalid-secret-value" }))
      .toThrow(/^Invalid server environment: DATABASE_URL$/);
  });
});
