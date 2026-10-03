# Verification Slice
**Status:** Approved (Noel Bobby, 2026-10-03)

## Approach

Build one backend verification path before adding the task board, shared chat, or autonomous AI evaluation. Accept a repository URL and exact commit SHA, run that revision in an isolated Freestyle VM, and use Playwright to check one requirement: a declined payment displays an error and allows retry.

Use TypeScript with a backend API, Postgres-backed run storage and job queue, and a separate worker. Limit the initial implementation to one trusted Node web-app fixture with explicit setup and start commands. Store commands in server-owned project configuration, not arbitrary public request input. No production credentials enter the verification VM.

Record run states as queued, preparing, verifying, completed, or error. A completed check produces passed, failed, or unverified. Environment and tooling failures are run errors, not product defects. Persist screenshots and logs outside the VM before cleanup, and associate every result with the submitted commit and requirement.

The first check is deterministic, not an AI judgment. AI explanations, assistant-ui, GitHub webhooks, CoShell session synchronization, and automatic fixes are out of scope. The commands below are planned verification targets to establish during implementation; this workspace has no application scaffold yet.

## Steps

- [x] Scaffold the TypeScript API and worker, package scripts, environment validation, and test runner. Keep Freestyle and database credentials server-side.
verify: npm --prefix backend run typecheck

- [x] Define the submission and result schemas, including project ID, commit SHA, requirement ID, run state, check outcome, and evidence references. Reject unsupported projects and invalid revisions.
verify: npm --prefix backend run test -- submission

- [x] Add Postgres migrations for runs, jobs, and evidence metadata. Implement job claiming and persisted progress so a browser disconnect does not cancel verification; prevent duplicate claims and mark interrupted execution as an error.
verify: npm --prefix backend run test:integration -- jobs
Implemented in the independent `backend/` package. Fourteen real-Postgres integration tests verify transactional enqueueing, concurrent exclusive claims, durable progress/evidence metadata, lease renewal, stale-worker fencing, and terminal interrupted errors. The Verify command automatically provisions and cleans up Docker Postgres when `TEST_DATABASE_URL` is absent; an explicit URL must point to a disposable database. Tests never use the application's `DATABASE_URL`. The standalone worker recovers expired jobs, and `executeNextJob` provides executor orchestration independent of HTTP connections; production execution is wired in the full-path step below.

- [x] Add submission and run-status endpoints. Return a run ID immediately and let clients retrieve progress and results. Restrict access to the demo team rather than exposing an anonymous code-execution endpoint.
verify: npm --prefix backend run test -- api

- [x] Prepare a small checkout fixture repository with broken and fixed revisions. Define setup/start commands, the declined-payment response, and stable selectors for the error message and retry action.
verify: npm --prefix backend run test:fixture
Implemented as a dedicated local Git repository in `fixtures/checkout`; immutable broken/fixed SHAs, commands, response contract, and selectors are in `fixtures/checkout-revisions.json`. The fixture requires no dependencies or credentials. Targeted Chromium tests archive each exact commit into a unique `/tmp/opencode` directory, verify the broken blank state and fixed error/retry/cart behavior, then clean up. Tests use the workspace root's existing Playwright dependency: install root dependencies with `npm ci` and Chromium with `npx playwright install chromium` (or `npx playwright install --with-deps chromium` if OS libraries are missing). This fixture is local-only, not publicly cloneable or added to the remote project allowlist; the general verifier and VM integration are separate steps.

- [x] Integrate the current Freestyle SDK. Create an isolated VM, fetch and verify the exact commit, install dependencies, start the app, and wait for readiness. Apply execution deadlines and a run budget; use test credentials only and clean up failed environments.
verify: npm --prefix backend run test:integration -- freestyle
Implemented in `backend/src/freestyle.ts` with `freestyle@0.2.16`; 15 SDK-boundary tests pass using an injected client (no live VMs). Requires a trusted toolchain snapshot and fixture configuration. Worker orchestration, Playwright, durable evidence, and live provider/full-path verification remain in the subsequent steps.

- [x] Implement the Playwright check: return a declined-payment response, submit checkout, assert a visible error, and verify retry can submit again. Capture screenshots, network observations, and logs on failure.
verify: npm --prefix backend run test:integration -- checkout
Implemented in `backend/src/checkout.ts` with a guest entrypoint in `backend/src/checkout-runner.ts`. Seven real-Chromium integration tests pass: fixed revision passes, broken revision fails with PNG/network/log evidence, nonfunctional retry fails, guest runner writes failure artifacts, unavailable app is a run error, cancellation is interrupted, and artifact-write failure preserves the primary report. The same check is applied to both immutable revisions with synthetic declined-payment responses. The evidence step below transfers artifacts outside the VM; production worker wiring and live provider verification remain outstanding.

- [x] Persist evidence outside the VM, expose authorized evidence references in the report, and delete the VM after evidence collection. Verify cleanup on successful, failed, and timed-out runs without losing the primary result.
verify: npm --prefix backend run test:integration -- evidence-cleanup
Implemented in `backend/src/evidence-storage.ts`, `evidence.ts`, and `verification.ts`, with a separate bounded collection phase before Freestyle deletion and an authenticated run-scoped evidence download route. Forty-nine tests pass using real filesystem storage/HTTP and injected VM/metadata boundaries; they verify post-deletion persistence, primary-result preservation for success/failure/timeout, cleanup deadlines, partial artifacts, orphan removal, schema/size limits, and authorization. Configure a shared persistent `EVIDENCE_DIRECTORY`; the production worker/snapshot wiring and live provider verification remain in the full-path step.

- [x] Verify the full path against both fixture commits: broken returns failed with evidence, fixed returns passed, and startup failure returns a run error. Confirm reports preserve the exact commit SHA.
verify: npm --prefix backend run test:e2e -- verification
The local Verify command automatically provisions and cleans up Docker Postgres when `TEST_DATABASE_URL` is absent; no provider credentials are needed for this repeatable local regression check. The separate live suite described below verifies actual Freestyle execution.
Verified on 2026-10-03: the plan command passes all three local end-to-end tests, and `npm --prefix backend run test:live` passes all three actual Freestyle scenarios through the standalone production worker. Broken returns `completed/failed` with PNG/network/log evidence; fixed returns `completed/passed` with two declined POSTs; a real startup exit returns `error/environment` without an outcome. Every report preserves its exact submitted SHA, and provider-confirmed VM deletion precedes authenticated evidence downloads. Run IDs and retained evidence are recorded in `docs/local-verification.md` and `.data/live-verification/`. The disposable Postgres container, schemas, workers, and VMs were cleaned up. No fixture publication or custom snapshot was needed.

- [x] Document local setup, required credentials, migration and worker commands, and the demo submission sequence. Review the evidence with Noel before expanding scope to shared contracts or assistant-ui.
Setup and demo documentation are updated in `backend/README.md`, `docs/local-verification.md`, and `docs/checkout-demo.md`. Live evidence is retained privately under `.data/live-verification/`. Noel Bobby reviewed and approved the verification slice on 2026-10-03. All plan steps are complete; no scope expansion has started.

## Acceptance Criteria

- A submission returns a run ID without waiting for the VM checks.
- The submitted revision, not a moving branch or shared CoShell worktree, is checked.
- The broken fixture fails with a screenshot and useful diagnostic evidence.
- The fixed fixture passes the same requirement and check.
- Startup failures and timeouts cannot produce a pass or be misreported as product defects.
- Evidence remains accessible after VM cleanup; secrets are not included in reports.
