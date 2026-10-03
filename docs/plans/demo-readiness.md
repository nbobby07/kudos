# Demo Readiness

**Status:** Approved (Noel Bobby, 2026-10-03)
**Goal:** Deliver a 2-3 minute judges' video and an approximately 3 minute live presentation showing a real blocked checkout handoff, a verified fix, and delivery to Noel.

## Scope

Treat `docs/plans/verification-slice.md` as the completed backend prerequisite. This plan covers connecting that implementation to the demo and proving readiness, not reimplementing it. If an acceptance check reveals missing backend functionality, record the blocker against the existing plan rather than simulate a successful result.

Use one requirement: `declined-payment-retry`. Broken must fail; fixed must pass. No autonomous fixes, successful-payment story, mobile approval, or duplicate-order guarantees are required. The prepared revision switch is a demo fix, not an AI repair.

For implementation, follow [Frontend Backend Integration](frontend-backend-integration.md) steps 1-6 sequentially. That plan is the execution checklist for the integration items below and uses the completed Git-bundle backend path; remote fixture publication is not required for that path. This readiness plan still tracks presentation and recording work. Do not mark its overlapping items complete until the corresponding integration acceptance checks pass.

Existing assets: `fixtures/checkout`, `fixtures/checkout-revisions.json`, `fixtures/checkout-handoff.json`, local rehearsal commands, and `docs/checkout-demo.md`.

Suggested ownership: Aryan handles frontend; Noel handles backend and deployment; Kiran handles fixture publication, acceptance testing, and presentation production. Confirm this split before execution. Check items off only after their acceptance checks pass.

## 1. Repository and Environment

- [x] Provide the checkout demo as a section of the existing shared project instead of requiring a new GitHub repository for local rehearsal. Include a portable copy of the existing Git history and document launch and restoration commands.
Owner: Kiran. Scope change: Kiran requested keeping the demo in the existing repository after GitHub authorization failures.
verify: `fixtures/checkout.bundle` passed Git bundle verification; a fresh clone resolved both exact SHAs from the manifest. Root README links the demo assets and rehearsal commands. Remote publication below is deferred, not completed by this local alternative.

- [ ] Choose the fixture's Git hosting location and publish its existing two-commit history without squashing or rewriting it. Preserve the broken and fixed SHAs from `fixtures/checkout-revisions.json`.
Owner: Kiran. Dependency: team approval of the remote and publication.
verify: From a fresh temporary clone, fetch and resolve both full SHAs over the credential-free HTTPS URL; compare them with the manifest.
Publication status: Kiran selected the public repository `nbobby07/relay-checkout-demo`. Creation was attempted but GitHub refused the acting account `kjblue3` permission to create under `nbobby07` (or the Coshell Drives app lacks Administration write permission). Noel must create an empty public repository at that location or authorize repository creation. No publication or remote-fetch verification has completed; both local commits remain unchanged.
Retry status: Noel requested creation from his own session; GitHub correctly used `nbobby07` but still refused repository creation. The remaining blocker is GitHub/app authorization, not the selected session identity. Create the empty public repository manually or grant the Coshell Drives app Administration read/write access, then retry publication and exact-SHA verification.
Current destination: Kiran subsequently selected `https://github.com/kjblue3/kudos-demo.git`. The repository already has `main`; publish the unchanged fixture history to the separate `checkout-fixture` branch without modifying `main`. Local `origin` now points to this URL, but the push was refused because `kjblue3` is not connected to this Coshell organization. Connect that account or grant a connected account/app write access, then retry the push and fresh-clone SHA verification. The earlier Noel-owned destination is superseded.

- [ ] Configure the trusted backend project as `checkout-fixture`, using the published URL, `npm run setup`, and `node server.js`. Keep project configuration server-owned.
Owner: Noel. Dependency: published repository.
verify: A valid fixture submission is accepted; unknown projects and request-supplied URLs or commands are rejected.

- [ ] Prepare the demo environment: Postgres migrations, API, executing worker, evidence storage, Freestyle credentials, and a trusted toolchain snapshot. Keep credentials server-side and use test data only.
Owner: Noel. Dependency: completed verification-slice plan.
verify: Health check succeeds, a submitted job progresses beyond queued, and a fresh VM can fetch and start the fixture. Record startup commands and nonsecret configuration in the runbook.

- [ ] Prove real backend execution against both pinned commits in the demo environment.
Owner: Noel and Kiran. Dependencies: trusted project and environment.
verify: Broken returns completed/failed with accessible screenshot and diagnostics; fixed returns completed/passed; startup failure returns error rather than passed. Reports retain exact SHAs and evidence remains readable after VM cleanup. Record actual run durations for presentation planning.

## 2. Frontend Integration

- [ ] Replace the verification simulation with a trusted server-side backend adapter. Submit project ID, full commit SHA, and requirement ID; persist the returned run ID and poll status. Keep team tokens out of browser code and responses.
Owner: Aryan. Dependency: configured backend API.
verify: Browser network traffic contains no backend credentials; real submissions return run IDs; reload or browser disconnect does not cancel the backend job or lose the pending run.

- [ ] Show the shared handoff contract and explicit selected revision. Use `checkout-handoff.json` for Aryan's responsibility, Noel's dependency, and the payment-failure acceptance criteria.
Owner: Aryan. Dependency: adapter.
verify: Before submission, the screen identifies who owns the work, who receives it, what is being checked, and whether broken or fixed is selected. Only the actual supported requirement is represented as verified.

- [ ] Display real progress, findings, and authorized evidence. Map queued/preparing/verifying/completed/error; distinguish passed, failed, and unverified. Replace synthetic evidence and remove simulation labels only for genuinely connected functionality.
Owner: Aryan. Dependency: backend run and evidence access.
verify: Broken shows its real screenshot and failed requirement; fixed shows its real passing result; network and execution errors have actionable retry messaging and never appear green. Evidence remains available after reload.

- [ ] Enforce the verified handoff gate on the server, not only through a disabled button. Allow delivery only for a completed passed result matching the selected revision and unchanged requirement/contract snapshot. Keep self-reported task delivery clearly separate from verified delivery.
Owner: Aryan and Noel. Dependencies: real run results and contract display.
verify: Direct requests cannot deliver failed, pending, unverified, errored, or stale results. Changing the revision or relevant requirement invalidates readiness; repeated send attempts do not create duplicate deliveries.

- [ ] Connect Noel's incoming report to the real delivered handoff and synchronize the two teammate views.
Owner: Aryan. Dependency: enforced handoff gate.
verify: Noel receives nothing from the failed attempt; after the passing attempt, his separate browser session receives exactly one report with sender, requirement, verified SHA, outcome, and accessible evidence.

## 3. Demo Experience and Acceptance

- [ ] Make the checkout and report legible for recording and projection. If restyling the fixture, preserve selectors and behavior, create new revisions, update the manifest, and repeat broken/fixed acceptance tests before using those new SHAs.
Owner: Aryan and Kiran. Dependency: working integrated flow.
verify: Failure screenshot, requirement, blocked state, and recipient report are readable at presentation size; no unexpected overflow obscures controls. Visual polish does not imply mobile behavior has been verified by the backend.

- [ ] Provide a repeatable, demo-scoped reset procedure. Clear previous demo handoffs and pending UI selections safely, select broken initially, and prepare the fixed revision. Do not delete shared users' work, run history, or evidence.
Owner: Aryan and Kiran. Dependency: delivery persistence.
verify: Two complete rehearsals start with Noel's demo inbox empty and produce the same blocked -> fixed -> verified -> delivered sequence. Local previews use 4173/4174 without colliding with API or Relay ports.

- [ ] Run an end-to-end two-browser acceptance test through the actual frontend and backend, including a reconnect and one verification error.
Owner: Kiran, with Aryan and Noel. Dependencies: all integration items.
verify: Broken is blocked with evidence, fixed is delivered once, SHA is preserved, refresh recovers status, and verification errors cannot authorize a handoff. Capture the passing run IDs and any unresolved blockers in the runbook.

## 4. Judges' Video

- [ ] Finalize and record a 2-3 minute standalone walkthrough. Target 2:40: problem (15s), contract (20s), broken verification (40s), prepared fix and rerun (35s), Noel's report (30s), differentiator and close (20s).
Owner: Kiran; Aryan and Noel demonstrate their roles. Dependency: end-to-end acceptance.
verify: Recording shows actual app/browser evidence, a blocked handoff, the same check passing after the fix, and the recipient view. Label time skips and disclose deterministic payment mocking; hide credentials and private data.

- [ ] Review and export the submission video against the hackathon's actual format, size, audio, and submission rules.
Owner: Kiran. Dependency: recorded walkthrough.
verify: Final exported file plays correctly, lasts 2-3 minutes, has legible text and clear audio, and the submitted file/link can be opened by judges. Confirm deadline and link permissions.

## 5. Live Presentation

- [ ] Finalize the approximately 3 minute script and speaker handoffs. Hook: "Everyone has a teammate whose definition of 'done' is 'your problem now.' And sometimes, that teammate is us." Follow with one requirement, one blocked attempt, one prepared fix, and Noel's report.
Owner: Kiran, Aryan, and Noel. Dependency: measured verification durations.
verify: Rehearsal fits approximately 3 minutes with enough time for real execution. If runs are too slow, use clearly disclosed preverified results for part of the story rather than silently substituting simulation.

- [ ] Prepare a fallback recording and rehearse the switch if connectivity, the VM provider, or browser automation fails. Separate recorded evidence from live state explicitly.
Owner: Kiran. Dependency: judges' recording.
verify: Backup plays locally without network access; presenter can switch within 10 seconds and explain that the audience is viewing a recorded real run.

- [ ] Complete a stage rehearsal and final environment reset. Confirm devices, browser sessions, projection readability, URLs, power, audio, provider budget, and correct selected revision; hide notifications and secrets.
Owner: All three. Dependencies: reset procedure, script, and fallback.
verify: One timed rehearsal succeeds on presentation equipment; Noel starts with no demo delivery; both browser views and backup recording are ready before presenting.

## Definition of Ready

- Both exact fixture revisions are remotely fetchable and tested in the actual verification environment.
- The frontend shows real results and evidence, and cannot bypass or reuse a stale approval.
- Noel receives the verified handoff only after the passing check.
- The reset is repeatable and does not disturb shared work.
- The judges' video is submitted and accessible within its 2-3 minute limit.
- The live presentation fits approximately 3 minutes and has an honest offline fallback.

## Runbook Record

Fill these in during execution; never put tokens or private keys here.

| Item | Value |
| --- | --- |
| Published fixture HTTPS URL | Selected: `https://github.com/kjblue3/kudos-demo.git`, branch `checkout-fixture`; push blocked, fixture not yet published |
| Frontend presentation URL | To confirm |
| Backend startup / worker startup / migration commands | To confirm |
| Broken acceptance run ID and duration | To confirm |
| Fixed acceptance run ID and duration | To confirm |
| Demo reset procedure | To confirm |
| Final video location and submission confirmation | To confirm |
| Offline fallback location | To confirm |
| Remaining blockers | Connect `kjblue3` to this Coshell organization or authorize a connected account/app to push to `kjblue3/kudos-demo`; fixture push and fresh-clone SHA verification pending |
