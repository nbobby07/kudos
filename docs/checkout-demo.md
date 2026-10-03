# Checkout Handoff Demo

## Company and team story

See [Paper / Field's company brief and demo script](paperfield-story.md). Aryan is the Storefront Engineer, Noel the Commerce Engineer, and Kiran the Product & Launch Lead. Their shared milestone is the company's first online notebook launch. The same missing payment-error state blocks Noel's integration and Kiran's downstream launch sign-off.

## Repository and contract

Reuse `fixtures/checkout`, the dedicated Git repository containing both demo revisions. Do not copy its current working tree into a new repository or squash its history: the backend verifies exact commits.

`fixtures/checkout-revisions.json` supplies pinned revisions, setup/start commands, the API response, and stable selectors. `fixtures/checkout-handoff.json` supplies presentation metadata for Aryan -> Noel, with Kiran reviewing. It is not an API request schema.

| Scenario | Commit | Expected completed outcome |
| --- | --- | --- |
| Broken | `05d773013cc4d9beeeba8cea513fc108f659cd28` | `failed` |
| Fixed | `e0c69bf8dba700d5a8e5a48ebbc504b7064a3575` | `passed` |

Both revisions always decline payment. Broken clears the checkout contents; fixed displays the error and permits another request. This fixture deliberately has no successful-payment scenario, real payment provider, or automatic fix.

## Rehearsal

### Polished presentation versions

Run `npm run demo:polished:broken` on port 4176 and `npm run demo:polished:fixed` on port 4175. These versions look identical before payment. Broken clears the checkout after a decline; fixed displays the error and permits retry. `npm run test:demo:polished` checks screenshot equality and both behaviors, including mobile overflow.

These commands serve current files, not the original pinned commits. The polished fixed files are in `fixtures/checkout`; the matching broken files are in `fixtures/checkout-broken`. The existing revision manifest and bundle still describe the original bare-bones commits. New commits and corresponding integration metadata are needed before remote verification can use the polished versions; no old SHA has been repurposed.

The demo is maintained as a section of the existing project, not a separate GitHub repository. `fixtures/checkout.bundle` contains the complete pinned two-commit history so it can be shared even when nested `.git` directories are omitted.

To restore the fixture in a fresh copy where `fixtures/checkout` is absent:

```bash
git clone fixtures/checkout.bundle fixtures/checkout
```

If that path already contains files but no Git history, clone to a separate unused path instead; do not overwrite teammates' files. The bundle can also be cloned into a separate repository for inspecting either exact SHA.

Requires Node 22+, npm, Git, and tar. From the workspace root:

```bash
npm run demo:broken
```

Open `http://127.0.0.1:4173` and click **Pay $12.00** to see the missing failure state. Stop with Ctrl+C, then:

```bash
npm run demo:fixed
```

The same payment now shows the decline message and an enabled **Retry payment** button. Each command exports the pinned commit to a temporary directory, runs setup, and cleans up on normal shutdown. It never checks out, resets, or modifies the shared fixture repository. Restarting resets the browser scenario; reload the page to clear client state.

Use `DEMO_PORT=4174 npm run demo:broken` for another preview port. Port 4173 avoids the backend's default 3000 and Relay's 5173. `DEMO_HOST=0.0.0.0` exposes the preview beyond loopback; use only in the trusted demo environment. Backend `PORT` and `HOST` variables do not override the preview.

## Backend integration

The backend already enables the trusted `checkout-fixture` project and only the two immutable manifest SHAs. The production executor transfers a Git bundle from the local fixture repository to Freestyle, verifies detached HEAD, runs setup/start, and executes the browser check. A published remote repository and custom snapshot are not required; GitHub publication remains deferred by team choice. Keep the restored fixture Git history alongside the backend. Do not configure the local bundle as an HTTPS repository URL.

The local preview does not replace VM verification. The standalone production worker has now passed real Freestyle broken/fixed/startup-failure scenarios. Follow [standalone setup and live results](local-verification.md) for credentials, migrations, worker commands, retained evidence, and the scope of verification. Frontend presentation remains a separate integration concern.

Send this body to `POST /submissions` from Relay's trusted server adapter, with the backend's demo-team authentication. Keep credentials on the server:

```json
{
  "projectId": "checkout-fixture",
  "commitSha": "05d773013cc4d9beeeba8cea513fc108f659cd28",
  "requirementId": "declined-payment-retry"
}
```

For the fixed submission, replace only `commitSha` with `e0c69bf8dba700d5a8e5a48ebbc504b7064a3575`. Do not send repository URLs, commands, teammate metadata, or selectors in this strict request body. Poll `GET /runs/:id` using the returned run ID.

## Frontend integration

- Display the owner, recipient, dependency, and acceptance criteria from `checkout-handoff.json`.
- Associate the pending handoff with the submitted full commit SHA and returned run ID.
- Map `queued`, `preparing`, and `verifying` to progress, not approval.
- A completed `failed` result blocks delivery and displays authorized evidence from that run.
- A completed `passed` result enables delivery only for that same revision and unchanged requirement.
- `error` or `unverified` means verification did not establish readiness; neither is a pass.
- Noel's incoming report should retain the submitted revision, requirement, outcome, and evidence references.
- Do not claim this one check verifies mobile layout, successful payments, or backend idempotency.

## Presentation sequence

1. Aryan shows checkout and the payment-failure requirement Noel depends on.
2. Submit the broken SHA through Relay; show the real verification failure and its screenshot.
3. Switch to the fixed revision and describe the small prepared fix. Do not present a revision switch as an autonomous AI repair.
4. Submit the fixed SHA through the same path; show the error and retry behavior passing.
5. Deliver to Noel and show the verified revision and evidence in his report.

For live side-by-side previews, run broken on 4173 and fixed on 4174. The selected backend SHA, not the open preview window, determines what gets verified.

## Verification

```bash
npm run test:demo
npm run test:fixture
```

The first checks launcher startup, pinned revision reporting, the API response, and shutdown. The second uses Chromium to test both immutable commits, including loading, the broken blank state, and fixed error/retry behavior. Install workspace dependencies and Playwright Chromium before browser tests. These local tests do not establish remote accessibility or full frontend-to-VM integration.
