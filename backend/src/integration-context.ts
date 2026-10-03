import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { z } from "zod";
import { commitShaSchema, requirementIdSchema, createVerificationSchemas,
  type Submission, type VerificationResult } from "./submission.js";

const submissionSchema = z.strictObject({ projectId: z.string().min(1),
  commitSha: commitShaSchema, requirementId: requirementIdSchema });
const contextSchema = z.object({ sender: z.json(), recipient: z.json(), contractSnapshot: z.json() }).catchall(z.json());
export type IntegrationContext = z.infer<typeof contextSchema>;
export type IntegrationRecord = {
  requestKey: string; upstreamKey: string; submission: Submission; context: IntegrationContext;
  runId: string | null; status: VerificationResult | null; revision: number;
};
export class IntegrationConflictError extends Error {
  constructor() { super("Integration intent conflict"); this.name = "IntegrationConflictError"; }
}
const sameSubmission = (a: Submission, b: Submission) => a.projectId === b.projectId
  && a.commitSha === b.commitSha && a.requirementId === b.requirementId;
const ranks = { queued: 0, preparing: 1, verifying: 2, completed: 3, error: 3 };

export class IntegrationContextStore {
  private pendingCursor = 0;
  constructor(private readonly pool: pg.Pool, private readonly workspaceId: string,
    private readonly backendIdentity: string) {
    z.string().min(1).parse(workspaceId);
    z.string().min(1).parse(backendIdentity);
  }

  private record(row: pg.QueryResultRow): IntegrationRecord {
    return { requestKey: row.request_key, upstreamKey: row.upstream_key, submission: row.submission,
      context: row.context, runId: row.run_id, status: row.status, revision: Number(row.revision) };
  }

  private async locked<T>(work: (client: pg.PoolClient, revision: number) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO integration_workspaces(workspace_id, backend_identity)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [this.workspaceId, this.backendIdentity]);
      const { rows } = await client.query(`SELECT revision FROM integration_workspaces
        WHERE workspace_id = $1 AND backend_identity = $2 FOR UPDATE`, [this.workspaceId, this.backendIdentity]);
      const result = await work(client, Number(rows[0].revision));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async bump(client: pg.PoolClient): Promise<number> {
    const { rows } = await client.query(`UPDATE integration_workspaces SET revision = revision + 1
      WHERE workspace_id = $1 AND backend_identity = $2 RETURNING revision`, [this.workspaceId, this.backendIdentity]);
    return Number(rows[0].revision);
  }

  private async lookup(client: pg.Pool | pg.PoolClient, field: "request_key" | "run_id", value: string) {
    const { rows } = await client.query(`SELECT * FROM integration_contexts
      WHERE workspace_id = $1 AND backend_identity = $2 AND ${field} = $3`,
    [this.workspaceId, this.backendIdentity, z.uuid().parse(value)]);
    return rows[0] ? this.record(rows[0]) : null;
  }

  getByKey(key: string): Promise<IntegrationRecord | null> { return this.lookup(this.pool, "request_key", key); }
  getByRun(runId: string): Promise<IntegrationRecord | null> { return this.lookup(this.pool, "run_id", runId); }

  async begin(requestKey: string, input: Submission, context: IntegrationContext): Promise<IntegrationRecord> {
    const key = z.uuid().parse(requestKey).toLowerCase();
    const submission = submissionSchema.parse(input);
    return this.locked(async (client) => {
      const old = await this.lookup(client, "request_key", key);
      if (old) {
        if (!sameSubmission(old.submission, submission)) throw new IntegrationConflictError();
        // Retry context is deliberately ignored: the original contract and parties are immutable.
        return old;
      }
      const parsedContext = contextSchema.parse(context);
      const revision = await this.bump(client);
      const { rows } = await client.query(`INSERT INTO integration_contexts
        (workspace_id, backend_identity, request_key, upstream_key, submission, context, revision, created_revision)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [this.workspaceId, this.backendIdentity, key, randomUUID(), submission, parsedContext, revision]);
      return this.record(rows[0]);
    });
  }

  async accept(requestKey: string, runId: string): Promise<IntegrationRecord> {
    const id = z.uuid().parse(runId).toLowerCase();
    return this.locked(async (client) => {
      const old = await this.lookup(client, "request_key", requestKey);
      if (!old) throw new IntegrationConflictError();
      if (old.runId === id) return old;
      if (old.runId !== null || await this.lookup(client, "run_id", id)) throw new IntegrationConflictError();
      const revision = await this.bump(client);
      const { rows } = await client.query(`UPDATE integration_contexts SET run_id = $4, revision = $5
        WHERE workspace_id = $1 AND backend_identity = $2 AND request_key = $3 RETURNING *`,
      [this.workspaceId, this.backendIdentity, old.requestKey, id, revision]);
      return this.record(rows[0]);
    });
  }

  async updateStatus(requestKey: string, input: VerificationResult): Promise<IntegrationRecord> {
    return this.locked(async (client) => {
      const old = await this.lookup(client, "request_key", requestKey);
      if (!old) throw new IntegrationConflictError();
      const schemas = createVerificationSchemas([{ id: old.submission.projectId,
        repositoryUrl: "https://example.invalid", setupCommand: "", startCommand: "" }]);
      const result = schemas.resultSchema.parse(input);
      result.runId = result.runId.toLowerCase();
      if (old.runId !== result.runId || !sameSubmission(old.submission, result)) {
        throw new IntegrationConflictError();
      }
      if (old.status && (ranks[old.status.state] === 3 || ranks[result.state] < ranks[old.status.state])) return old;
      // Evidence is append-only; delayed status responses must not erase previously observed refs.
      const refs = new Map((old.status?.evidenceRefs ?? []).map((ref) => [ref.id, ref]));
      for (const ref of result.evidenceRefs) {
        const existing = refs.get(ref.id);
        if (existing && existing.kind !== ref.kind) throw new IntegrationConflictError();
        refs.set(ref.id, ref);
      }
      result.evidenceRefs = [...refs.values()];
      if (isDeepStrictEqual(old.status, result)) return old;
      const revision = await this.bump(client);
      const { rows } = await client.query(`UPDATE integration_contexts SET status = $4, revision = $5
        WHERE workspace_id = $1 AND backend_identity = $2 AND request_key = $3 RETURNING *`,
      [this.workspaceId, this.backendIdentity, old.requestKey, result, revision]);
      return this.record(rows[0]);
    });
  }

  private async list(pending: boolean, limit: number): Promise<IntegrationRecord[]> {
    z.number().int().min(1).max(10000).parse(limit);
    const { rows } = await this.pool.query(`SELECT * FROM integration_contexts
      WHERE workspace_id = $1 AND backend_identity = $2
      ${pending ? "AND (run_id IS NULL OR status IS NULL OR status->>'state' NOT IN ('completed', 'error'))" : ""}
      ORDER BY ${pending ? "(created_revision <= $4) ASC, created_revision ASC" : "created_revision DESC"} LIMIT $3`,
    pending ? [this.workspaceId, this.backendIdentity, limit, this.pendingCursor]
      : [this.workspaceId, this.backendIdentity, limit]);
    // Rotate even unchanged/failing records so a bounded recovery batch cannot starve later intents.
    if (pending && rows.length) this.pendingCursor = Number(rows[rows.length - 1].created_revision);
    return rows.map((row) => this.record(row));
  }
  listPending(limit = 100): Promise<IntegrationRecord[]> { return this.list(true, limit); }
  listRecent(limit = 100): Promise<IntegrationRecord[]> { return this.list(false, limit); }

  snapshot(): Promise<{ revision: number; runs: IntegrationRecord[] }> {
    return this.locked(async (client, revision) => {
      const { rows } = await client.query(`SELECT * FROM integration_contexts
        WHERE workspace_id = $1 AND backend_identity = $2 ORDER BY created_revision DESC`,
      [this.workspaceId, this.backendIdentity]);
      return { revision, runs: rows.map((row) => this.record(row)) };
    });
  }
}
