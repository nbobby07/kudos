CREATE TABLE submission_keys (
  key uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES verification_runs(id) DEFERRABLE INITIALLY DEFERRED,
  submission jsonb NOT NULL CHECK (jsonb_typeof(submission) = 'object')
);

CREATE TABLE integration_workspaces (
  workspace_id text NOT NULL CHECK (length(workspace_id) > 0),
  backend_identity text NOT NULL CHECK (length(backend_identity) > 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (workspace_id, backend_identity)
);

CREATE TABLE integration_contexts (
  workspace_id text NOT NULL,
  backend_identity text NOT NULL,
  request_key uuid NOT NULL,
  upstream_key uuid NOT NULL UNIQUE,
  submission jsonb NOT NULL CHECK (jsonb_typeof(submission) = 'object'),
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'
    AND context ?& ARRAY['sender', 'recipient', 'contractSnapshot']),
  run_id uuid,
  status jsonb CHECK (jsonb_typeof(status) = 'object' AND status ?& ARRAY['state', 'runId']
    AND jsonb_typeof(status->'state') = 'string'
    AND status->>'state' IN ('queued', 'preparing', 'verifying', 'completed', 'error')),
  revision bigint NOT NULL CHECK (revision > 0),
  created_revision bigint NOT NULL CHECK (created_revision > 0),
  PRIMARY KEY (workspace_id, backend_identity, request_key),
  UNIQUE (workspace_id, backend_identity, run_id),
  FOREIGN KEY (workspace_id, backend_identity)
    REFERENCES integration_workspaces(workspace_id, backend_identity),
  CHECK (status IS NULL OR (run_id IS NOT NULL AND jsonb_typeof(status->'runId') = 'string'
    AND status->>'runId' = run_id::text))
);
CREATE INDEX integration_contexts_recent ON integration_contexts
  (workspace_id, backend_identity, created_revision DESC);
