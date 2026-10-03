CREATE TABLE verification_runs (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-fA-F0-9]{40}$' AND commit_sha <> repeat('0', 40)),
  requirement_id text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'preparing', 'verifying', 'completed', 'error')),
  outcome text CHECK (outcome IN ('passed', 'failed', 'unverified')),
  error_code text CHECK (error_code IN ('environment', 'tooling', 'timeout', 'interrupted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'completed' AND outcome IS NOT NULL AND error_code IS NULL)
    OR (state = 'error' AND error_code IS NOT NULL AND outcome IS NULL)
    OR (state IN ('queued', 'preparing', 'verifying') AND outcome IS NULL AND error_code IS NULL))
);

CREATE TABLE verification_jobs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES verification_runs(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'finished')),
  claim_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'queued' AND claim_token IS NULL AND lease_expires_at IS NULL)
    OR (state = 'claimed' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state = 'finished' AND claim_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX verification_jobs_queue ON verification_jobs(created_at, id) WHERE state = 'queued';
CREATE INDEX verification_jobs_leases ON verification_jobs(lease_expires_at) WHERE state = 'claimed';

CREATE TABLE verification_evidence (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES verification_runs(id),
  kind text NOT NULL CHECK (kind IN ('screenshot', 'log', 'network')),
  storage_key text NOT NULL CHECK (length(storage_key) > 0),
  content_type text NOT NULL CHECK (length(content_type) > 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX verification_evidence_run ON verification_evidence(run_id);
