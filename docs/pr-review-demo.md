# PR Review Demo

This is a server-side, deterministic rehearsal. It does not authenticate with GitHub, fetch code, execute commands, call Freestyle, apply patches, or run tests. Owner selection is a demo identity, not authorization suitable for production. Existing task completion, deliveries, and verification remain independent. No frontend changes are required by this implementation.

## State Contract

Every successful endpoint returns HTTP 200 with the full application snapshot. `GET /api/state` and `/api/events` expose the same state, including asynchronous progress. Updates are persisted in `DATA_DIR/state.json`.

`state.github` contains `accounts` (owner to `{login}` map), `repository: 'checkout-team/checkout'`, and `prs` with `{number,title,author,headSha,files}`. The hardcoded account logins are `Aryan: aryan-checkout`, `Noel: noel-checkout`, and `Kiran: kiran-checkout`. Accounts start empty.

| PR | Author | Title | Initial Mock SHA | File |
| --- | --- | --- | --- | --- |
| 42 | aryan-checkout | Handle declined checkout payments | demo-pr-42-001 | src/checkout.js |
| 43 | noel-checkout | Return predictable checkout responses | demo-pr-43-001 | api/checkout.js |
| 44 | kiran-checkout | Test checkout on mobile | demo-pr-44-001 | tests/checkout.spec.js |

`state.prReviews` starts as `[]`. Each review has:

```js
{
  owner, taskId, prNumber, headSha,
  id, // UUID
  status, // running | completed | error
  step, // 0 initially, then 1..4
  findings: [{ severity, file, line, title, body }],
  messages: [{ id, role, text, sentAt }], // UUID, assistant | user, ISO timestamp
  fixed, // boolean: true only for an explicitly requested simulated fix
  taskSnapshot // deep copy of the owner's task when this review starts
}
```

Mock SHAs are deliberately labeled strings, not Git commit hashes. Reviews retain their captured SHA and task snapshot when later state changes.

## API

All four routes are POST with JSON bodies. Only the listed fields are accepted; no URL, command, repository, or arbitrary SHA input is supported.

| Route | Body | Behavior |
| --- | --- | --- |
| `/api/github-connect` | `{ "owner": "Aryan" }` | Idempotently stores the hardcoded login. No OAuth or network call. |
| `/api/pr-review` | `{ "owner": "Aryan", "taskId": "declined", "prNumber": 42 }` | Requires a connected owner, an existing task belonging to that owner, and numeric fixture PR 42, 43, or 44. Captures the task and current mock head SHA. |
| `/api/pr-review-chat` | `{ "owner": "Aryan", "reviewId": "UUID", "text": "Why does this matter?" }` | Requires ownership and completed status. Accepts nonblank text of at most 2000 characters, appends user and deterministic assistant messages. |
| `/api/pr-review-fix` | `{ "owner": "Aryan", "reviewId": "UUID" }` | Requires ownership, completed status, and a still-existing task. Creates a NEW review with `fixed: true` and SHA `demo-pr-N-fix-UUID`, updates the fixture head, and leaves the prior review intact. |

Other convenient task/PR combinations are Noel's `responses` with PR 43 and Kiran's `test-plan` with PR 44. Any existing owner task may be manually associated with any fixture PR; authors are not an ownership restriction.

Reviews start `running`, step 0, with empty findings/messages. Four asynchronous steps run approximately 450ms apart (persistence can add latency). At step 4 the review becomes `completed` and adds a proactive assistant message. Ordinary reviews produce one predefined finding scoped to the fixture file: declined retry state (#42, high, line 38), response code consistency (#43, high, line 27), or mobile retry assertions (#44, medium, line 52). Simulated fix reviews produce no findings. These are not actual check results.

Chat recognizes scope/files/SHA/task, tests/testing, fix/resolve/repair, and why/explain/reason, in that precedence order. Replies reference the captured review and fixture. Unrecognized requests explicitly say this is not general AI; text is never executed or used to fetch URLs. Asking about a fix does not trigger one.

Invalid owner, unsupported fields, task/PR, or chat text returns 400; disconnected account, incomplete review, or duplicate running task+PR returns 409; another owner's review returns 403; missing review returns 404. Errors contain `{error}` rather than a full snapshot. Duplicate guards cover both ordinary and fix reviews. On restart, persisted running reviews become `error` with an explanatory assistant message; no automatic replay occurs. Completed reviews and history survive restart. Task flags, verification, and global demo fix state are never modified by these routes.

## Verification

```sh
node --check server.js
node --test docs/pr-review-demo.test.mjs
```

The API test uses an isolated temporary data directory and loopback ephemeral port, avoiding workspace state and frontend builds.

## Production Recommendations

- Use a GitHub App for repository installation permissions and checks; use OAuth or verified sign-in for human identity. An installation identity is not a user identity. Enforce authenticated workspace membership and review ownership server-side, not a submitted owner name.
- Verify webhook signatures and delivery IDs, and pin fetched diffs, checks, findings, and fix results to the webhook head SHA. Handle synchronize events, stale reviews, replay protection, and idempotency explicitly.
- Model tasks and PRs many-to-many with stable task IDs. Parse task references from PR bodies as proposed links, resolve them within the authenticated workspace, and require manual confirmation before association or completion. Do not infer task completion from a clean review alone.
- Run scoped checks in isolated sandboxes with resource limits and restricted network access. Treat PR text and code as untrusted. Do not inject production secrets or permit production access, and do not execute arbitrary submitted commands or URLs.
- Integrate assistant-ui with typed server tools and explicit approvals for mutations, patches, commits, pushes, and reruns. Show tool provenance, captured SHA, scope, and simulated versus real status. Keep chat advice separate from approval authority and verification evidence.
