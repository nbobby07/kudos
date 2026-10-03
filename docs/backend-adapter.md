# Trusted Backend Adapter

Steps 1 and 2 of [Frontend Backend Integration](plans/frontend-backend-integration.md) implement server-side transport, durable run context, idempotency, and recovery, not the real frontend or verified delivery flow. The dashboard remains a rehearsal simulation until step 3. In real mode, its old Verify and acknowledgment actions return unavailable rather than simulate success.

## Configuration

Configure the root workspace server through its process environment. It does not load `backend/.env`; the backend API/worker have their own configuration. Never put tokens in chat, browser variables, command arguments, or committed files.

| Variable | Meaning |
| --- | --- |
| `VERIFICATION_MODE` | `real` enables the adapter; `simulation` keeps rehearsal separate. An unconfigured server retains the existing simulation default. Any nonempty backend setting without an explicit mode rejects startup. |
| `VERIFICATION_BACKEND_URL` | Backend origin, for example `http://127.0.0.1:3000`. No user credentials, path, query, or fragment. Nonloopback origins require HTTPS. |
| `VERIFICATION_BACKEND_TOKEN` | Server-only value matching the backend's `DEMO_TEAM_TOKEN`, 32-256 letters, digits, underscores, or hyphens. |
| `VERIFICATION_DATABASE_URL` | Required real-mode Postgres connection for durable workspace context. May share the backend database or use a separately migrated database. Never sent to the browser. |
| `VERIFICATION_WORKSPACE_ID` | Required stable workspace identifier, at most 200 characters. Keep it unchanged across restarts to recover this workspace's runs. |
| `VERIFICATION_TIMEOUT_MS` | Per-upstream-call deadline covering headers and body, default `5000`, allowed `10`-`30000`. |
| `PORT` | Workspace port, default `5173`. Use a different port from the backend. |

Install backend dependencies and run `npm run build` before starting the root server, which loads the compiled database/context modules. With these variables securely supplied, run `npm start`. Real startup applies additive context migrations to its configured database; its database role needs DDL privileges. Apply the backend's migrations separately if its API uses a different database. Real mode binds only to `127.0.0.1` regardless of `HOST`. Missing/invalid backend settings, unavailable startup storage, or missing compiled artifacts fail closed with safe `503` responses, never simulation. Correct startup configuration/storage failures and restart the server. Simulation mode never uses supplied backend credentials.

## Private Boundary

This increment is a local, trusted demo deployment, not an authenticated multi-user service. Real mode checks the socket's loopback address, the exact local Host/port, same-origin Origin when supplied, and browser Fetch Metadata. Forwarded headers do not grant access. The boundary protects static pages and every workspace route, including state/SSE/chat, not just verification.

Open the local workspace URL using `127.0.0.1` or `localhost`. A public reverse proxy or public Freestyle preview URL is intentionally unsupported. Do not bypass the checks to publish it; add an authenticated deployment boundary first. Local processes/users with access to the loopback server share the demo workspace, and persona selection is not identity authentication.

## Routes

| Route | Behavior |
| --- | --- |
| `POST /api/verification/submissions` | Strict JSON payload and exactly one UUID `Idempotency-Key` header; returns `202`, `{runId}`, and workspace-scoped `Location` after backend acceptance is durably associated, without waiting for execution. |
| `GET /api/verification/context` | Durable submission contexts, including pending intent, last validated status, and monotonic revision. Available without a successful upstream status read. |
| `GET /api/verification/runs/<uuid>` | Sanitized backend status for a durably associated run in this workspace/backend namespace. A failed read returns `503` with `statusUnavailable: true` without erasing saved progress. |
| `GET /api/verification/runs/<uuid>/evidence/<uuid>` | Authorized PNG or schema-validated network/log JSON; checks fresh matching run status and reference before fetching bytes. |

Submission fields are exactly `projectId`, `commitSha`, and `requirementId`. Use `checkout-fixture`, an exact broken/fixed SHA from `fixtures/checkout-revisions.json`, and `declined-payment-retry`. Request-supplied repository URLs, commands, extra fields, unsupported revisions, query strings, and unsupported methods are rejected.

Runs cannot be adopted by guessing an ID. Status must match the accepted project, SHA, and requirement; evidence must belong to that run. Browser credentials are never forwarded upstream, and upstream tokens, arbitrary fields, response headers, raw errors, or redirects are never forwarded downstream. JSON is bounded to 16 KiB, artifacts to 5 MiB. Protected responses use `no-store` and `nosniff`.

## Current Limits

Submission intent, upstream idempotency key, exact revision, requirement, sender/recipient, captured contract, accepted ID, and validated progress are stored in Postgres before acknowledging browser acceptance. Reuse the same browser request key for retries; changed submission fields with that key return `409`. A retry retains the original parties and contract even if the workspace contract has since changed. The adapter uses a different immutable upstream key, never exposed to the browser. The backend atomically deduplicates that key with its run/job enqueue transaction. Existing unkeyed backend clients still work but have no retry deduplication.

Background polling runs independently of browsers. It reconciles ambiguous acceptance using the same upstream key, then polls nonterminal runs with bounded backoff. Rotating batches prevent pending runs from being permanently starved. On restart it recovers from Postgres; transient upstream failures preserve known progress. Lower lifecycle states and delayed evidence subsets cannot overwrite newer observations, and terminal outcomes are immutable.

Contexts are scoped by workspace ID and a server-only hash of backend origin/token. Changing the backend URL/token selects a new namespace; it does not adopt unrelated runs. Keep the origin stable across restarts. Context snapshots currently return full history with no retention/capacity policy, spending budget, or global queue limit. Do not expose the server publicly or permit unrestricted paid submissions. Worker, Postgres, and shared evidence storage remain backend requirements; this adapter does not manage Freestyle VMs.

Real snapshots are published separately as `state.verification`, never converted into legacy simulated `state.run` or handoffs. Workspace SSE and POST snapshots carry a persisted sequence, and the browser ignores older snapshots. Atomic JSON replacement protects the workspace mirror; Postgres remains authoritative for verification. Use one root process per workspace data directory; this file-backed collaboration state is not a distributed multi-instance store.

Saved simulation run/handoff fields are excluded from real-mode state so they cannot grant real verification authority. Frontend state rendering, evidence presentation, and verified handoff authorization remain later steps.

## Tests

Run `npm run test:adapter` and `npm run check`. Adapter tests use isolated fake HTTP upstreams and spawned workspace servers with temporary state, random ports, and no provider calls. They cover exact payloads, credential non-exposure, status/evidence scoping, malformed responses, redirects, bounded reads/timeouts, Host/Origin protection, configuration ambiguity, and simulation isolation.

Run `env -u TEST_DATABASE_URL npm --prefix backend run test:integration -- integration-context` for disposable-Postgres tests of migrations, concurrent deduplication, lost acknowledgments, immutable context, status/evidence ordering, batch fairness, and actual spawned-root restart/background recovery through the backend HTTP API. Those tests use manual job transitions, not Freestyle. The browser suite also tests delayed POST/SSE ordering.

Recorded regression checks are in the integration plan. Live Freestyle validation is separate and paid; it is not part of these tests.
