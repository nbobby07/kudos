# Handoff Verifier Backend

Independent TypeScript backend package. Use Node.js 22.12+ (22.x), 24.x, or 26+. Run the commands below from the workspace root; the frontend package is separate.

## Setup And Scripts

Install with `npm --prefix backend install`. Configure `backend/.env` using `backend/.env.example`: `DATABASE_URL`, `FREESTYLE_API_KEY`, and `DEMO_TEAM_TOKEN` are required by the runtime environment validator. Generate a team token with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep credentials server-side and never commit `.env`, expose them in frontend variables, or include the token in URLs or logs.

- `npm --prefix backend run dev:api`: watch the API, defaulting to `127.0.0.1:3000`.
- `npm --prefix backend run dev:worker`: watch the standalone worker.
- `npm --prefix backend run build`: compile source into `backend/dist/`.
- `npm --prefix backend run start:api`: run the compiled API.
- `npm --prefix backend run start:worker`: run the compiled worker.
- `npm --prefix backend run typecheck`: check source and test types.
- `npm --prefix backend test`: run unit tests, excluding `tests/integration/**`.
- `npm --prefix backend run test:watch`: watch unit tests.
- `npm --prefix backend run migrate`: apply Postgres migrations using `DATABASE_URL`.
- `npm --prefix backend run test:integration`: run only `tests/integration/**/*.test.ts`.

Runtime and migration commands load `backend/.env` if present. Unit tests use synthetic configuration and do not require Postgres or Freestyle.

## Postgres And Migrations

Provision a real Postgres database and set `DATABASE_URL` before running the migration command. `migrations/001_verification.sql` creates runs, jobs, and evidence metadata. Migration execution is transactional, serialized with an advisory lock, and recorded in `schema_migrations`; applying it again skips an already recorded migration.

Database integration and local end-to-end tests use real Postgres, not mocked storage. If `TEST_DATABASE_URL` is absent, `tests/test-database.ts` starts an isolated Docker `postgres:17` container on a free loopback port, waits for readiness, and removes the container and its volume after the suite. Docker must be available; missing infrastructure produces an explicit failure rather than a skipped test. This makes the plan's Verify commands work without manually injecting a database URL. Non-database suites do not start Postgres.

Alternatively, set `TEST_DATABASE_URL` explicitly to your own disposable database, for example:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/handoff_test npm --prefix backend run test:integration -- jobs
```

Never point integration tests at production or shared demo data. Tests do not load `.env` or fall back to the application's `DATABASE_URL`. An explicitly supplied test database is not stopped or deleted; tests only create/drop their isolated random schemas. Jobs tests exercise real Postgres transactions, concurrent claims, lease recovery, evidence metadata, and worker interruption. The separate opt-in live Freestyle harness still requires an explicit disposable `TEST_DATABASE_URL` and authorized provider credentials.

## Leases And Worker Scope

The job store persists enqueueing and progress in Postgres, independently of browser connections. Claims use transactional row locking with `SKIP LOCKED`, a unique claim token, and a lease (30 seconds by default). Heartbeats extend a live lease; progress, evidence, and completion mutations require the matching token and an unexpired lease. Expired claims are recovered as terminal `error` runs with `errorCode: "interrupted"`, not silently retried or reported as product failures.

The standalone worker recovers expired claims at startup and every second until SIGINT/SIGTERM. Live claims owned by another worker are left alone. `executeNextJob` supplies claiming, lease renewal, and terminal persistence around an executor callback; shutdown or lost ownership aborts the callback and prevents a stale pass. Hard process termination is detected once the lease expires. Executors must respect their abort signal to stop external work and perform cleanup; evidence metadata already committed remains available after interruption.

The standalone worker consumes queued work through `src/executor.ts` and `verifyCheckoutInFreestyle`. It bundles the trusted local fixture, deploys the built guest runner, installs Chromium on `freestyle/ubuntu-sm`, and persists evidence before VM cleanup. Build before starting even a source-mode worker. Shutdown waits for executor cleanup before closing the database pool. All three live scenarios passed on 2026-10-03; see [verification setup and results](../docs/local-verification.md).

`GET /health` is liveness only. The API entrypoint wires the Postgres job store through `createRunStore`; submit returns only after a durable run/job transaction commits. Submission/status routes require the team bearer token. The trusted project allowlist accepts only `checkout-fixture` and the two immutable manifest revisions. Repository URLs and commands cannot be supplied by clients.

## Submission And Polling

See the [workspace API documentation](../README.md#submission-api-boundary) for request/response examples and errors. `POST /submissions` accepts only the trusted project's ID, a full nonzero commit SHA, and `declined-payment-retry`; no URLs or shell commands can be supplied. JSON bodies are capped at 16 KiB, including streamed bodies. A successful transaction returns `202` with `runId` and a `/runs/<uuid>` Location header. Authenticated `GET /runs/<uuid>` reads persisted progress and schema-validated results, with opaque evidence references only. Both routes use server-only bearer authentication, secure token comparison, and `Cache-Control: no-store`.

An optional UUID `Idempotency-Key` on submissions atomically deduplicates retries with the same payload, including after a lost acknowledgment or completion. Different payloads under the same key return safe `409`; malformed/duplicate key headers return `400`. Existing unkeyed submissions remain supported but are not retry-safe. Migration `002_integration_context` adds key reservations and durable workspace context. Database connections, queries, and statements have five-second deadlines. See [adapter setup](../docs/backend-adapter.md) for workspace scoping, background recovery, and root-server configuration.

`npm --prefix backend run test -- api` exercises injected stores without infrastructure. `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/handoff_test npm --prefix backend run test:integration -- api` verifies the same HTTP endpoints against real Postgres, including reconnect durability, progress/results, and rollback on failed job insertion. The database must be disposable; tests create and drop a random schema.

## Freestyle Execution

`src/freestyle.ts` uses the current `freestyle@0.2.16` SDK. `withFreestyleApp(options, check, collect)` creates one fresh VM, fetches a full exact commit SHA over credential-free HTTPS, checks detached `HEAD` before running repository commands, executes the trusted setup/start commands, and polls a private loopback readiness URL. The check callback receives the VM handle, verified SHA, local app URL, abort signal, and execution deadline. Browser checks must run inside the VM; the adapter does not publish an Internet-accessible preview.

Supply a server-owned `snapshotId` containing `git`, the fixture's Node version, `npm`, and `curl`; preferably pin an immutable `sh-...` snapshot rather than a moving slug. Missing tooling is an error, not a product failure. Supply the project, app port, and readiness path from trusted server configuration, never HTTP request input. Setup should install locked dependencies (for example `npm ci`), and the start command must honor `PORT` and `HOST`. Use only synthetic test credentials in the fixture. Database, demo-team, and Freestyle credentials are never forwarded; the only injected values are `CI=1`, `NODE_ENV=test`, `PORT`, and `HOST`.

The default total run budget is ten minutes, with two-minute command deadlines and a thirty-second readiness deadline. Configuration is capped at fifteen minutes; SDK commands are capped at five minutes. VM runtime policies and a deletion TTL provide a fallback if the controller dies. The VM has outbound public Internet access for Git/dependencies, no shared VPC, and no public ingress rule. This is for the trusted fixture only, not arbitrary user repositories or hostile-code execution.

The optional collection callback runs after execution, including on preparation failure, callback failure, and timeout, with a fresh abort signal and a separate ten-second deadline. VM runtime policies reserve this finalization window. Deletion follows collection with its own ten-second deadline, including eventual reclamation of a VM handle returned after creation times out. Collection and deletion failures emit sanitized diagnostic events and never replace a known primary result or error. TTL remains the fallback for failed/ambiguous deletion. Raw command output and SDK transport messages are not exposed through adapter errors.

`npm --prefix backend run test:integration -- freestyle` tests SDK-boundary behavior with an injected mock client, including exact checkout, readiness failure, deadlines, late creation, and cleanup. It creates no paid VMs and requires no credentials. `npm --prefix backend run test:live` is the separate opt-in standalone-worker/provider harness; it requires an exported authorized `FREESTYLE_API_KEY` and disposable `TEST_DATABASE_URL`. A remote fixture and custom snapshot are not required. All three live scenarios passed in this workspace; `docs/local-verification.md` includes environment-file invocation and retained evidence locations.

## Checkout Check

`src/checkout.ts` implements the deterministic `declined-payment-retry` requirement using headless Chromium. It intercepts fixture `POST /checkout` requests with a synthetic 402 `PAYMENT_DECLINED` response, submits checkout, asserts the visible decline message, and clicks retry. A pass requires a second declined POST and an enabled retry action afterward; merely displaying a retry button is insufficient.

Assertion mismatches return `completed/failed`. Browser, navigation, and interaction-tool failures return run errors; cancellation returns `error/interrupted`. On failure, the check captures a full-page PNG when the page remains available, bounded network observations, and structured diagnostic events identifying the failing stage. Diagnostics omit arbitrary console text, request bodies, headers, and URL tokens. Screenshot capture is best-effort and cannot replace the primary result.

Run `npm --prefix backend run test:integration -- checkout` to exercise both immutable fixture revisions with real local Chromium, a nonfunctional retry, failure artifact writing, unavailable app, and cancellation. Install backend dependencies with `npm --prefix backend ci` and, if needed, install matching Chromium with `npm exec --prefix backend -- playwright install chromium` (add `--with-deps` if OS libraries are missing).

For guest execution, deploy the built backend package and its production dependencies outside the application worktree in a browser-ready VM. Run `APP_URL=http://127.0.0.1:3000 node dist/checkout-runner.js /tmp/verification-evidence` from that package directory. The runner writes `result.json` first, then independently attempts `network.json`, `logs.json`, and `failure.png` when captured. A written report uses exit code zero even for a failed requirement, a recorded run error, or a secondary artifact-write failure; callers must read its `state` and `outcome`. Nonzero exit means runner/report-writing failure, not a product defect. Enforce the Freestyle execution timeout and total run budget around this command.

## Evidence And Cleanup

`src/verification.ts` supplies `verifyCheckoutInFreestyle`, an executor building block that marks the claim verifying, runs the trusted guest entrypoint (default `/opt/verifier/dist/checkout-runner.js`), validates the primary report, persists available artifacts in the collection phase, and then deletes the VM. It returns only the primary terminal result for job completion. The production worker uses it through `src/executor.ts`, whose preparation callback deploys/installs the runner under `/tmp/verification-runner` before marking verifying. Lease heartbeats remain active through normal finalization. Live tests verified this flow and provider-confirmed deletion before authorized evidence downloads.

`src/evidence.ts` reads only fixed guest filenames through authenticated SDK file transfer, caps each artifact at 5 MiB, validates PNG signatures, and schema-validates structured network/log JSON. It does not collect raw application logs, request bodies, headers, or guest-supplied paths. Each upload gets a server-generated UUID; bytes are stored before the live-claim-fenced metadata transaction. Failed uploads or metadata registration trigger best-effort orphan deletion without discarding other artifacts or replacing the primary result. Missing or partial artifacts on timeout cannot become a pass. Screenshots contain fixture UI only; do not use production data or credentials in the fixture.

`EvidenceStorage` stores bytes outside the VM using private filesystem permissions, atomic writes, and file/directory fsync. Configure the API and worker with the same absolute `EVIDENCE_DIRECTORY` on a persistent volume. The default `.data/evidence` resolves relative to each process's working directory; it is not a distributed object store and does not survive deletion of the host volume. Retention/garbage collection is not implemented.

Reports retain opaque `{ id, kind }` references. Retrieve an artifact with `GET /runs/<runId>/evidence/<evidenceId>` and the same demo-team bearer token used for the report. Authentication runs before ID validation or storage access; metadata lookup is scoped to both the run and artifact. Downloads return only allowlisted PNG/JSON content types with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, never storage keys or public signed URLs. The shared demo-team token authorizes the entire demo team's runs, not individual users.

`npm --prefix backend run test:integration -- evidence-cleanup` uses real private filesystem storage and HTTP with injected VM/metadata boundaries. It verifies persistence after VM deletion, successful/failed/timed-out primary-result preservation, collection ordering, independent deadlines, partial artifacts, orphan removal, cancellation fencing, schema/size limits, and authorized retrieval. These tests do not contact Freestyle or prove a live-provider run.
