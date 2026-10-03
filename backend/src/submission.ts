import { z } from "zod";
import { supportedProjects, type TrustedProject } from "./projects.js";

export const requirementIdSchema = z.literal("declined-payment-retry");
export const commitShaSchema = z.string().length(40).regex(/^[a-fA-F0-9]{40}$/)
  .refine((value) => !/^0{40}$/.test(value), "A nonzero full commit SHA is required");
export const runStateSchema = z.enum(["queued", "preparing", "verifying", "completed", "error"]);
export const checkOutcomeSchema = z.enum(["passed", "failed", "unverified"]);

// IDs refer to authorized, sanitized evidence stored outside the VM, not
// storage locations, signed URLs, raw logs, or arbitrary diagnostic text.
export const evidenceReferenceSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["screenshot", "log", "network"]),
});

// This configuration is supplied by server code, never by a request body.
export function createVerificationSchemas(projects: readonly TrustedProject[] = supportedProjects) {
  const projectIds = new Set(projects.map((project) => project.id));
  const submissionFields = {
    projectId: z.string().min(1).refine((id) => projectIds.has(id), "Unsupported project"),
    commitSha: commitShaSchema,
    requirementId: requirementIdSchema,
  };
  const resultFields = {
    ...submissionFields,
    runId: z.uuid(),
    evidenceRefs: z.array(evidenceReferenceSchema),
  };

  return {
    submissionSchema: z.strictObject(submissionFields).refine((input) => {
      const project = projects.find((project) => project.id === input.projectId);
      return !project?.revisions || project.revisions.includes(input.commitSha.toLowerCase());
    }, "Unsupported fixture revision"),
    resultSchema: z.discriminatedUnion("state", [
      z.strictObject({ ...resultFields, state: z.literal("queued") }),
      z.strictObject({ ...resultFields, state: z.literal("preparing") }),
      z.strictObject({ ...resultFields, state: z.literal("verifying") }),
      z.strictObject({ ...resultFields, state: z.literal("completed"), outcome: checkOutcomeSchema }),
      z.strictObject({
        ...resultFields,
        state: z.literal("error"),
        errorCode: z.enum(["environment", "tooling", "timeout", "interrupted"]),
      }),
    ]),
  };
}

export const { submissionSchema, resultSchema } = createVerificationSchemas();
export type Submission = z.infer<typeof submissionSchema>;
export type VerificationResult = z.infer<typeof resultSchema>;
