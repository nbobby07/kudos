import { z } from "zod";
import { resolve } from "node:path";

export const demoTeamTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/);

const schema = z.object({
  DEMO_TEAM_TOKEN: demoTeamTokenSchema,
  DATABASE_URL: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return ["postgres:", "postgresql:"].includes(url.protocol) && !!url.hostname;
    } catch {
      return false;
    }
  }),
  FREESTYLE_API_KEY: z.string().trim().min(1),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  EVIDENCE_DIRECTORY: z.string().trim().min(1).default(".data/evidence").transform((value) => resolve(value)),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Report field names only: validation output must not disclose credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid server environment: ${fields.join(", ")}`);
  }
  return result.data;
}
