# Handoff Verifier

The frontend demo and isolated verification backend are separate packages. `npm install` and `npm start` at the workspace root run the existing frontend demo; its simulated verification is not the durable verification API. The TypeScript backend lives in `backend/` and requires Node.js 22.12+ (22.x), 24.x, or 26+.

A [trusted backend adapter](docs/backend-adapter.md) now provides server-side submission, status, evidence, durable context, and restart recovery in explicit, loopback-only real mode. The dashboard is not yet connected to these real runs; follow the [sequential integration plan](docs/plans/frontend-backend-integration.md). Run `npm run test:adapter` for the adapter's isolated tests.

## Checkout Demo

The demo lives in this project's `fixtures/` section; no separate GitHub repository is needed for local rehearsal.

```sh
npm run demo:broken
# Open http://127.0.0.1:4173 and click Pay $12.00.
# Stop with Ctrl+C, then run:
npm run demo:fixed
```

Broken removes the checkout contents after a declined payment. Fixed displays the decline message and permits retry. Both commands run isolated copies of exact commits without changing the shared fixture worktree.

- `fixtures/checkout/`: checkout app and its two-commit Git history.
- `fixtures/checkout-revisions.json`: exact SHAs, setup/start commands, response, and selectors.
- `fixtures/checkout-handoff.json`: Aryan -> Noel handoff metadata and acceptance criteria.
- `fixtures/checkout.bundle`: portable Git history, verified by cloning and resolving both pinned SHAs; include this file when sharing the project because an outer Git repository does not automatically include nested Git history.
- [Demo runbook](docs/checkout-demo.md): integration, rehearsal, and restoration instructions.
- [Readiness plan](docs/plans/demo-readiness.md): integration and presentation checklist.

Run `npm run test:demo` and `npm run test:fixture` to check the launcher and both browser scenarios. The bundle enables offline restoration; it does not provide a public HTTPS repository for Freestyle's current remote-fetch adapter.

## Backend Development

Install the backend with `npm --prefix backend install`. Configure `DATABASE_URL`, `FREESTYLE_API_KEY`, and `DEMO_TEAM_TOKEN` in the process environment or `backend/.env`, using `backend/.env.example`. Apply migrations with `npm --prefix backend run migrate` before starting the API. Both processes validate configuration at startup. Generate the team token with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`; it must contain 32-256 letters, digits, underscores, or hyphens. Keep credentials server-side; do not commit `.env` or expose them in frontend variables, URLs, or logs. Supply the team token only from a trusted demo client or server-side proxy, not a public browser bundle.

- `npm --prefix backend run dev:api`: start the API (defaults to `127.0.0.1:3000`; use a separate port if the frontend is running).
- `npm --prefix backend run dev:worker`: start the standalone worker.
- `npm --prefix backend run typecheck`: check source and test types.
- `npm --prefix backend run test -- api`: run focused API unit tests.
- `npm --prefix backend test`: run all backend unit tests.
- `npm --prefix backend run build`: compile server source to `backend/dist/`.
- `npm --prefix backend run start:api` and `npm --prefix backend run start:worker`: run compiled processes.

`GET /health` is public liveness only, not database/worker readiness. See [backend setup and queue documentation](backend/README.md) for migration, worker, and integration-test commands. Freestyle execution and browser checks are implemented; actual live-provider full-path verification remains unfinished.

## Submission API Boundary

Both routes require `Authorization: Bearer <DEMO_TEAM_TOKEN>` and return `401` before parsing input or accessing storage for missing/invalid authentication. Responses are not cached.

- `POST /submissions`: JSON with exactly `projectId`, a nonzero full 40-character `commitSha`, and `requirementId: "declined-payment-retry"`. Bodies are limited to 16 KiB. Returns `202` with `{ "runId": "<uuid>" }` and `Location: /runs/<uuid>` after durable persistence and enqueueing, without waiting for verification.
- `GET /runs/<uuid>`: returns the stored schema-validated progress/result record, including exact revision, state, outcome or error code when applicable, and opaque evidence references. Unknown IDs return `404`; malformed IDs return `400`.

`createApiServer` accepts server-owned `projects` and a `RunStore` adapter. `createAndEnqueue` must atomically persist the run and job before resolving; `getRun` must read persisted progress. Request bodies cannot supply repository URLs or commands. No in-memory store is used in production.

The production entrypoint uses the Postgres `JobStore` through `createRunStore`. All holders of the demo token share access to the demo team's runs; there is no multi-team model or anonymous execution. The trusted project allowlist accepts `checkout-fixture` at the two immutable SHAs in `fixtures/checkout-revisions.json`. The standalone worker executes durable queued work through Freestyle, using a local Git bundle without publishing the fixture. No fake results are generated. Live provider verification is still blocked on an authorized server-side API key; see [verification setup, coverage, and limitations](docs/local-verification.md).

Errors use `{ "error": "<safe message>" }`: `400` for invalid submissions/JSON/IDs, `401` for missing or invalid authentication, `404` for unknown routes/runs, `405` for unsupported methods (with `Allow`), `409` for idempotency conflicts, `413` for oversized bodies, `415` for non-JSON media types, and `503` for unavailable storage/queue or invalid stored records. Errors never include request tokens, database errors, or raw evidence. A `503` does not return an accepted ID and does not prove that no commit occurred.

`POST /submissions` supports an optional UUID `Idempotency-Key` header. Reusing it with the same payload returns the original run ID, including after completion; a different payload returns `409`. The key, run, and job commit atomically, so lost acknowledgments and concurrent retries do not enqueue duplicates. Unkeyed callers retain the previous behavior and can create duplicates when retrying. The workspace adapter requires a browser request key and durably maps it to its own immutable upstream key.

## API Examples

These commands assume a trusted fixture project has been configured and its exact commit SHA is known. Use a trusted local client with `DEMO_TEAM_TOKEN` in its environment; do not paste real tokens into shared terminals or logs.

```sh
curl -i http://127.0.0.1:3000/submissions \
  -H "Authorization: Bearer $DEMO_TEAM_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"projectId":"checkout-fixture","commitSha":"abcdef01abcdef01abcdef01abcdef01abcdef01","requirementId":"declined-payment-retry"}'
# HTTP 202, Location: /runs/<uuid>, body: {"runId":"<uuid>"}

# Set RUN_ID to the ID returned above.
curl "http://127.0.0.1:3000/runs/$RUN_ID" \
  -H "Authorization: Bearer $DEMO_TEAM_TOKEN"
```

A queued report contains `runId`, `projectId`, exact `commitSha`, `requirementId`, `state: "queued"`, and `evidenceRefs: []`. Later polls return `preparing`, `verifying`, `completed` with `outcome`, or `error` with `errorCode`. Evidence references are opaque IDs and kinds, not download URLs; evidence retrieval is a later step.

Real Postgres API verification uses a disposable database:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/handoff_test \
  npm --prefix backend run test:integration -- api
```

The tests isolate their tables in a random schema and remove that schema afterward. They verify durable enqueueing, progress/results across reconnect, and transaction rollback when job insertion fails; they do not run Freestyle or browsers.
