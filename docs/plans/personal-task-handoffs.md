# Personal Task Handoffs
**Status:** Draft — pending review

## Approach

Keep Relay's existing soft green theme, but make the selected teammate's own work the primary experience. The home page greets Aryan, presents two lists, and keeps Noel and Kiran in a secondary right-hand column. On mobile, the teammate column moves below the task lists.

The two lists are **My tasks for today**, a checkable working plan, and **Recommended by AI**, optional suggestions that can be added to that plan. Recommendations remain explicitly labeled curated demo content until a real AI service is connected. Do not introduce a chatbot, autonomous fixes, daily scheduling, or a broader project-management system in this iteration.

Completing every current task unlocks each teammate's Send button. The server must enforce the same completion gate. Sending captures an immutable checklist snapshot for that recipient's inbox; later edits must not rewrite a delivered list. Task completion is self-reported, not proof that the API contract passed. Preserve the separate Verification page and its distinction between simulated checks and real evidence.

The current prototype already contains the basic layout, task persistence, live updates, and direct delivery. The steps below cover reviewing and hardening that implementation rather than rebuilding it. Keep this frontend work separate from the approved backend plan in `verification-slice.md`; real Freestyle verification integration is not authorized by this draft.

## Steps

- [ ] Review the personal dashboard with Aryan: confirm the greeting, the two list names and order, initial tasks, and right-hand teammate placement.

- [ ] Audit and refine desktop and 375px mobile layouts while preserving the current theme. Check keyboard access, checkbox focus, readable text, disabled Send explanations, and task progress.
verify: npx playwright test tests/handoff.spec.js --grep "mobile layout"

- [ ] Confirm that recommendations can be added once, become unchecked tasks, and lock sending until completed. Keep the curated-demo disclaimer visible; do not claim live AI generation.
verify: npx playwright test tests/handoff.spec.js --grep "personal task completion"

- [ ] Harden task-state persistence and live synchronization across separate browser sessions. Cover reloads, concurrent edits, failed saves, and clear recovery messaging without resetting existing teammate data.
verify: npx playwright test tests/handoff.spec.js --grep "personal task completion"

- [ ] Verify server-side delivery gating: reject incomplete or stale task lists, invalid recipients, and self-delivery. Prevent duplicate deliveries of the same task-list version to the same recipient.
verify: npx playwright test tests/handoff.spec.js --grep "personal task completion"

- [ ] Verify recipient-specific inbox delivery and immutable task snapshots. Later additions or unchecked tasks must affect future readiness without changing what was already sent.
verify: npx playwright test tests/handoff.spec.js --grep "personal task completion"

- [ ] Preserve the separate contract-verification flow and clearly distinguish self-reported completion, simulated passing checks, and unverified execution failures.
verify: npx playwright test tests/handoff.spec.js --grep "shared blocked handoff"

- [ ] Extend the existing browser tests for the additional edge cases above, run the full frontend checks, and review the two-teammate demo before refreshing the shared app on port 5173.
verify: npm run check && npx playwright test

- [ ] Update `docs/frontend.md` with any approved behavior changes and remaining integration boundaries. Leave the backend API on port 3000 and its existing implementation plan unchanged.

## Acceptance Criteria

- Aryan's work is the main content; teammates remain secondary and reachable from the same page.
- The two lists have distinct purposes, and recommendations are not misrepresented as live AI output.
- Every current task must be checked before sending, enforced in both the UI and server.
- A recipient sees the delivered task snapshot through shared live state.
- Saved task state survives reloads, and delivered snapshots survive later task edits.
- Task checkmarks never become a verified contract result.
- Desktop, mobile, and keyboard interactions remain usable.

## Review Boundary

Await review before making further application changes. Approval of this plan covers the personal-task and direct-delivery experience only; connecting AI recommendations or real verification requires a separately agreed integration scope.
