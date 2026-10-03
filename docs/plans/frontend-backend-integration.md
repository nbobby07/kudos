# Frontend Backend Integration

**Status:** In progress at Noel Bobby's request. Steps 1 and 2 completed and locally verified on 2026-10-03.
**Goal:** Connect the existing dashboard to the completed verification backend, show real evidence, and deliver exactly one authorized, current passing report to Noel.
**Current step:** 3 (not started). Complete and verify each step before starting the next.

## Scope And Rules

- Prerequisite: `docs/plans/verification-slice.md`. Preserve its exact-revision, authenticated, durable queue and evidence behavior.
- Support only `checkout-fixture` and `declined-payment-retry`, using the broken/fixed SHAs in `fixtures/checkout-revisions.json`. Payments remain deterministic test declines.
- Use the existing Git-bundle transfer; remote fixture publication is not a dependency.
- Keep tasks, chat, and calendar working. Self-reported task delivery must never authorize verified delivery.
- Use a trusted server-side adapter. Never put backend tokens or Freestyle credentials in browser code, responses, URLs, or logs. The browser does not talk directly to Freestyle.
- Restrict deployment to a trusted/private demo boundary until authenticated workspace identity and server-side conversation authorization exist. A persona selector is not authentication.
- Simulation, if retained for rehearsal, must be explicit and isolated from real runs and deliveries. Never fall back to simulation on backend failure.
- Leave every implementation checkbox unchecked until its acceptance checks pass. Record commands, results, and blockers under the step. Update the current-step marker after completion.
- The verification targets below are to be implemented with their respective steps; they are not claims of existing tests. Tests must fail on missing coverage, not pass because no tests were collected.

## 1. Trusted Backend Adapter

- [x] Add a server-side client and workspace routes for submission, run status, and evidence access, with server-owned backend URL and token configuration.

Dependency: completed backend slice. Suggested lead: Noel.

Implementation:
- Submit the exact backend payload: `projectId`, `commitSha`, and `requirementId`. Select project/revisions from the manifest, never accept arbitrary URLs or commands.
- Preserve the accepted backend UUID and handle `202` without waiting for VM completion.
- Scope status and evidence proxy access to runs associated with this workspace; do not become a generic proxy for any backend run.
- Bound upstream waits, validate responses, sanitize errors, and avoid caching protected evidence. Backend outages must produce an honest unavailable state.
- Enforce the private demo deployment boundary before exposing these routes; fail closed when real-mode configuration is missing.

Acceptance: exact payload forwarded; unauthorized/unassociated run access rejected; malformed/upstream failures sanitized; credentials absent from browser-facing traffic; no simulated result on outage. Evidence transport is implemented here, its viewer in step 4.

Verification target: add root Node tests runnable with `node --test tests/backend-adapter.test.mjs`, using an isolated fake HTTP upstream rather than paid VMs. Also run `npm run check`.

Completion record: Completed 2026-10-03 in `backend-adapter.js`, with minimal `server.js` integration and 14 isolated tests in `tests/backend-adapter.test.mjs`. Real mode provides `/api/verification/submissions`, `/api/verification/runs/<uuid>`, and run-scoped evidence downloads. It binds only to loopback and rejects untrusted Host/Origin/Fetch Metadata or remote clients without trusting forwarded headers. Strict fixture submissions, validated/sanitized responses, streaming byte limits, header/body deadlines, and redirect rejection are covered. Backend settings without an explicit mode reject startup; unavailable real configuration never enables simulation. Legacy simulated verification/acknowledgment cannot grant authority in real mode. Associations are process-local until step 2; real frontend behavior remains blocked until step 3. Configuration and limitations are documented in `docs/backend-adapter.md`.

Verification record: `npm run test:adapter` (14), `npm test` (88), `env -u TEST_DATABASE_URL npm --prefix backend run test:integration` (94), `env -u TEST_DATABASE_URL npm --prefix backend run test:e2e -- verification` (3), `npm run test:fixture` (2), `npm run test:demo` (3), `npm run test:demo:polished` (2), and `env -u VERIFICATION_MODE -u VERIFICATION_BACKEND_URL -u VERIFICATION_BACKEND_TOKEN npx playwright test tests/handoff.spec.js` (9) all passed: 215 tests, zero failures. `npm run check`, `npm run typecheck`, and the backend build invoked by the integration suite passed. Database suites used disposable Docker Postgres, not application data; no containers remained after testing. No paid live-provider suite was run. Review caught and fixed ambiguous mode selection before completion.

## 2. Durable Run Context And Recovery

- [x] Persist each accepted run ID with its exact revision, requirement, sender/recipient, contract snapshot, and submission context; recover status after reconnect or restart.

Dependency: step 1. Suggested lead: Noel.

Implementation:
- Use Postgres for integration records rather than treating mutable `.data/state.json` as the authoritative verified-run history. Add migrations and explicit workspace/run associations.
- Persist submission intent before remote submission and the accepted ID afterward. Address the response-loss/crash window with backend submission idempotency and a durable request key; an ambiguous response must not trigger duplicate paid work.
- Poll accepted jobs from the server independently of browser connections, with bounded waits/backoff. Resume nonterminal runs after process restart.
- Persist accepted identity and context immutably. Temporary status-read failures do not turn a run into failed/passed, clear its ID, or resubmit it.
- Publish ordered workspace updates so delayed POST responses or SSE snapshots cannot overwrite newer verification state.

Acceptance: browser/server restart recovers the same UUID; two concurrent submissions/retries with one request key enqueue once; lost submission acknowledgment is recoverable; temporary read failures preserve the last known state; out-of-order updates are ignored.

Verification target: add disposable-Postgres integration coverage for run context and idempotency, runnable with `npm --prefix backend run test:integration -- integration-context`; no fallback to the application database. Add adapter recovery tests to the step 1 Node suite.

Completion record: Completed 2026-10-03. Migration `002_integration_context` and `backend/src/integration-context.ts` persist immutable intent/context, upstream keys, accepted IDs, validated status, and workspace/backend-scoped revisions. Key reservation and backend run/job enqueue are atomic; conflicting payloads return `409`, and existing unkeyed backend clients remain supported. The root adapter requires a UUID browser request key, persists intent before forwarding, safely recovers unknown acceptance with the same upstream key, and polls independently of browsers using bounded backoff and rotating batches. `GET /api/verification/context` recovers last-known progress without relying on successful upstream reads. Terminal states and append-only evidence are fenced against delayed responses. Real context stays in `state.verification`; ordered, atomically replaced workspace snapshots carry a durable sequence that browser POST/SSE consumers use to reject older updates. Configuration, build/migration requirements, and remaining limits are documented in `docs/backend-adapter.md`. The real frontend and verified delivery remain steps 3-5.

Verification record: `npm run test:adapter` (23), `npm test` (91), `env -u TEST_DATABASE_URL npm --prefix backend run test:integration` (107, including 13 integration-context tests), `env -u TEST_DATABASE_URL npm --prefix backend run test:e2e -- verification` (3), `npm run test:fixture` (2), `npm run test:demo` (3), `npm run test:demo:polished` (2), and the complete Playwright `tests/handoff.spec.js` suite with verification environment overrides unset (13) passed: 244 distinct tests. The focused integration-context command also passed independently. Build, typecheck, and syntax checks passed. Actual spawned root processes plus backend HTTP/Postgres tests proved restart recovery, immutable captured contracts, one run/job after lost acknowledgment, background status progression, temporary outage recovery, and cross-workspace scoping without running VMs. Review findings about recovery starvation and stale evidence were fixed with regressions. An initial browser navigation timeout did not reproduce on rerun; a concurrently changed calendar-copy assertion was updated, after which all browser tests passed. No paid provider calls or application database migrations were made; disposable database containers were cleaned up.

## 3. Real Frontend Run Model

- [ ] Replace simulated verification progress with the real backend run lifecycle and display the supported requirement and selected exact revision.

Dependency: step 2. Suggested lead: Aryan.

Implementation:
- Display owner, recipient, requirement, and selected broken/fixed SHA before submission, using the fixture manifest and handoff metadata.
- Represent `queued`, `preparing`, `verifying`, `completed`, and `error`; for completed runs distinguish `passed`, `failed`, and `unverified`.
- Render environment/tooling/timeout/interrupted errors separately from product-check failure. Green success requires an explicit completed passing result.
- Mark successful payment, mobile, and duplicate-order checks as outside verifier coverage. Editable prose does not create executable checks.
- Remove timer-based progress from real mode. Recover on reload through durable context; retry reads rather than submitting another job.
- Preserve failed contract-edit drafts and focus during updates; do not regress tasks/chat/calendar or their delivery semantics.

Acceptance: every backend state has an honest UI representation; no invented check counts or green incomplete/error state; SHA and requirement are visible; reload and ordering behavior work on desktop and mobile.

Verification target: extend `tests/handoff.spec.js` with deterministic state/adapter cases and run `npx playwright test tests/handoff.spec.js`. Existing simulations may test rehearsal only, not real integration acceptance.

Completion record: Not started.

## 4. Real Evidence Viewer

- [ ] Render backend PNG screenshots and network/diagnostic JSON through authorized workspace routes.

Dependency: step 3. Suggested lead: Aryan.

Implementation:
- Use opaque run/evidence IDs and the trusted proxy from step 1; never expose filesystem paths or provider handles.
- Show the broken revision's blank failure screenshot alongside its diagnostic stage and declined request, not as unexplained proof by itself.
- Show the fixed revision's two declined requests and passing diagnostic. Do not invent a success screenshot: current captures are failure-only.
- Handle missing/partial artifacts, unavailable storage, and authorization errors without changing the primary result. Render artifact text as data, not executable HTML.
- Ensure evidence remains readable after VM cleanup and browser reload. API and worker must use the same absolute persistent evidence volume for this demo.

Acceptance: actual stored artifacts appear under the correct run/SHA; protected downloads work after cleanup; cross-run access is rejected; missing screenshots do not imply a pass or erase a failure.

Verification target: add artifact success/error cases to adapter and Playwright tests; run `node --test tests/backend-adapter.test.mjs`, `npx playwright test tests/handoff.spec.js`, and `npm --prefix backend run test:integration -- evidence-cleanup`.

Completion record: Not started.

## 5. Durable Verified Delivery Gate

- [ ] Persist immutable verified handoffs and recipient acknowledgments; authorize delivery server-side only from a current matching completed passing run.

Dependency: step 4. Suggested leads: Noel and Aryan.

Implementation:
- Add Postgres handoff/acknowledgment records linked to the actual run, project, SHA, requirement, sender, recipient, contract snapshot, and evidence references.
- In a transaction, check the authoritative run and current selection/contract. Reject queued, preparing, verifying, failed, unverified, error, or stale runs, even for direct requests.
- Make repeated/concurrent sends idempotent with a database uniqueness constraint. Keep recipient and contract identity part of the delivery semantics.
- Acknowledge only as the authorized recipient under the chosen access boundary. Do not claim persona switching provides identity verification.
- Synchronize Noel's incoming report via workspace events and recover it after restart. Preserve old deliveries as historical, clearly marking stale/superseded context rather than presenting it as current readiness.
- Keep self-reported checklist delivery separate. Remove simulation's automatic authority to create real verified handoffs.

Acceptance: failed runs deliver nothing; a current passing run delivers once; direct gate bypasses fail; revision/contract changes invalidate readiness; historical reports and acknowledgments survive restart.

Verification target: add disposable-Postgres gate/concurrency tests runnable with `npm --prefix backend run test:integration -- verified-handoff`; add recipient/report cases to `tests/handoff.spec.js`.

Completion record: Not started.

## 6. Full Acceptance And Freestyle Validation

- [ ] Prove the complete two-browser flow and document a repeatable deployment/rehearsal procedure.

Dependency: steps 1-5. Suggested lead: Kiran, with Noel and Aryan.

Implementation:
- Add a dedicated Playwright integration configuration and suite that launch isolated workspace/API/worker processes, disposable Postgres, temporary evidence storage, and real exact-commit Chromium checks through a local execution adapter.
- Test Aryan and Noel in separate browser contexts: broken fails with real evidence/no delivery; fixed passes and delivers once; status and reports recover after reload/reconnect; startup error and stale approval cannot authorize delivery.
- Cover response-loss retry, concurrent send, acknowledgment, inaccessible evidence, and credential non-exposure. Check desktop/mobile UI without claiming backend mobile verification.
- Add explicit frontend/integration test scripts and a combined acceptance command. Update stale root documentation and record safe reset/startup procedures without deleting shared work.
- Separately rehearse the frontend-to-production-worker path on real Freestyle using authorized test credentials. Record run IDs, exact SHAs, durations, downloaded evidence, and provider-confirmed VM deletion. Local tests are not proof of live-provider execution.
- Before paid rehearsal, confirm private access, a bounded submission allowance/concurrency, provider budget, current backend build, migrations, and shared persistent evidence volume. No automatic paid calls in the default test suite.

Acceptance: local integrated suite passes, then real Freestyle broken/fixed/error scenarios pass through the frontend with honest reports, exactly-once passing delivery, evidence after deletion, and no unresolved release blockers.

Verification targets to add: `npm run test:frontend` for the current UI suite and `npm run test:integration:ui` for isolated full-stack local acceptance. Run `npm run check`, `npm run typecheck`, `npm test`, and `npm --prefix backend run test:e2e -- verification` as regressions. The existing `npm --prefix backend run test:live` is a supplementary paid backend check, not a substitute for the frontend live rehearsal.

Completion record: Not started. Record local and live results separately.

## Deferred Infrastructure Work

Track these separately; completing this plan does not imply they are solved: durable VM resource ledger/reconciliation, immutable toolchain images, database deadline and busy-worker recovery hardening, evidence commit-ambiguity/reconciliation/retention, distributed artifact storage, full multi-user authentication, and comprehensive spending controls. Any defect that blocks an acceptance criterion must be fixed before its step is checked off.

Persistent VM fork/edit/preview/promotion and arbitrary-repository execution remain out of scope. Keep the trusted fixture restriction; do not expand to untrusted code sharing the verifier's guest authority.

## Working Sequentially

Ask: "Do step 1 from docs/plans/frontend-backend-integration.md, verify it, and check it off." Continue with the next numbered step only after the previous completion record includes passing evidence. If blocked, leave the checkbox unchecked, record the blocker, and keep the current-step marker unchanged.
