import { describe, expect, it } from "vitest";
import { supportedProjects, type TrustedProject } from "../src/projects.js";
import {
  createVerificationSchemas,
  evidenceReferenceSchema,
  resultSchema as defaultResultSchema,
  submissionSchema as defaultSubmissionSchema,
} from "../src/submission.js";

// Synthetic server configuration, not an implemented or runnable fixture.
const projects: readonly TrustedProject[] = [{
  id: "test-checkout",
  repositoryUrl: "https://example.invalid/test-checkout.git",
  setupCommand: "npm ci",
  startCommand: "npm start",
}];
const { submissionSchema, resultSchema } = createVerificationSchemas(projects);
const submission = {
  projectId: "test-checkout",
  commitSha: "abcdef01".repeat(5),
  requirementId: "declined-payment-retry",
};
const evidence = { id: "11111111-1111-4111-8111-111111111111", kind: "screenshot" };
const result = {
  ...submission,
  runId: "22222222-2222-4222-8222-222222222222",
  evidenceRefs: [evidence],
};

describe("submission", () => {
  it("accepts an allowlisted project and preserves the exact SHA", () => {
    expect(submissionSchema.parse(submission)).toEqual(submission);
    const uppercase = { ...submission, commitSha: submission.commitSha.toUpperCase() };
    expect(submissionSchema.parse(uppercase)).toEqual(uppercase);
  });

  it("supports only the trusted fixture and its immutable revisions", () => {
    expect(supportedProjects).toHaveLength(1);
    const project = supportedProjects[0]!;
    for (const commitSha of project.revisions!) {
      expect(defaultSubmissionSchema.safeParse({ ...submission, projectId: project.id, commitSha }).success).toBe(true);
    }
    expect(defaultSubmissionSchema.safeParse({ ...submission, projectId: project.id }).success).toBe(false);
    expect(defaultSubmissionSchema.safeParse(submission).success).toBe(false);
    expect(defaultResultSchema.safeParse({ ...result, state: "completed", outcome: "passed" }).success)
      .toBe(false);
  });

  it.each(["unknown", "constructor", "__proto__", "", " test-checkout"])
    ("rejects unsupported project %s", (projectId) => {
      expect(submissionSchema.safeParse({ ...submission, projectId }).success).toBe(false);
    });

  it.each(["main", "HEAD", "abcdef0", "a".repeat(39), "a".repeat(41), "g".repeat(40),
    "0".repeat(40), ` ${submission.commitSha}`, `${submission.commitSha}\n`])
    ("rejects invalid revision %s", (commitSha) => {
      expect(submissionSchema.safeParse({ ...submission, commitSha }).success).toBe(false);
    });

  it("requires all submission fields and the supported requirement", () => {
    for (const field of ["projectId", "commitSha", "requirementId"] as const) {
      expect(submissionSchema.safeParse({ ...submission, [field]: undefined }).success).toBe(false);
    }
    expect(submissionSchema.safeParse({ ...submission, requirementId: "other" }).success).toBe(false);
  });

  it.each(["repositoryUrl", "setupCommand", "startCommand", "command", "credentials"])
    ("rejects request-controlled %s", (field) => {
      expect(submissionSchema.safeParse({ ...submission, [field]: "untrusted" }).success).toBe(false);
    });
});

describe("submission results", () => {
  it.each(["queued", "preparing", "verifying"])("accepts %s without an outcome", (state) => {
    expect(resultSchema.parse({ ...result, state, evidenceRefs: [] })).toEqual({
      ...result, state, evidenceRefs: [],
    });
    expect(resultSchema.safeParse({ ...result, state, outcome: "passed" }).success).toBe(false);
  });

  it.each(["passed", "failed", "unverified"])("accepts completed outcome %s", (outcome) => {
    expect(resultSchema.parse({ ...result, state: "completed", outcome })).toEqual({
      ...result, state: "completed", outcome,
    });
  });

  it("requires a completed outcome and rejects operational errors on completed results", () => {
    expect(resultSchema.safeParse({ ...result, state: "completed" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, state: "completed", outcome: "error" }).success).toBe(false);
    expect(resultSchema.safeParse({
      ...result, state: "completed", outcome: "passed", errorCode: "tooling",
    }).success).toBe(false);
  });

  it.each(["environment", "tooling", "timeout", "interrupted"])
    ("records %s as a run error, never a check outcome", (errorCode) => {
      expect(resultSchema.parse({ ...result, state: "error", errorCode })).toEqual({
        ...result, state: "error", errorCode,
      });
      for (const outcome of ["passed", "failed", "unverified"]) {
        expect(resultSchema.safeParse({ ...result, state: "error", errorCode, outcome }).success).toBe(false);
      }
    });

  it("rejects unknown states, missing error codes and free-form diagnostics", () => {
    expect(resultSchema.safeParse({ ...result, state: "unknown" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, state: "error" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, state: "error", errorCode: "secret text" }).success).toBe(false);
    expect(resultSchema.safeParse({
      ...result, state: "error", errorCode: "tooling", message: "secret text",
    }).success).toBe(false);
  });

  it("validates result identity and requires an explicit evidence list", () => {
    for (const invalid of [
      { projectId: "unknown" }, { commitSha: "main" }, { requirementId: "other" },
      { runId: "bad-id" }, { evidenceRefs: undefined },
    ]) {
      expect(resultSchema.safeParse({ ...result, state: "completed", outcome: "passed", ...invalid }).success)
        .toBe(false);
    }
  });

  it.each(["screenshot", "log", "network"])("accepts opaque %s evidence references", (kind) => {
    expect(evidenceReferenceSchema.parse({ ...evidence, kind })).toEqual({ ...evidence, kind });
  });

  it("rejects evidence URLs, paths, unknown kinds, secrets and arbitrary internals", () => {
    for (const invalid of [
      { ...evidence, id: "https://storage.invalid/evidence?secret=token" },
      { ...evidence, id: "/tmp/internal.log" }, { ...evidence, kind: "unknown" },
      ...["url", "path", "content", "credentials", "metadata"].map((field) => ({
        ...evidence, [field]: "private internal data",
      })),
    ]) {
      expect(resultSchema.safeParse({
        ...result, state: "completed", outcome: "failed", evidenceRefs: [invalid],
      }).success).toBe(false);
    }
  });
});
