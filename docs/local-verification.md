# Local Verification Coverage

Run from the workspace root with Node.js supported by `backend/package.json`, installed root/backend dependencies, and matching Playwright Chromium:

```sh
npm exec --prefix backend -- playwright install chromium
# Docker provides isolated Postgres automatically unless TEST_DATABASE_URL is supplied.
npm run test:e2e -- verification
```

When `TEST_DATABASE_URL` is absent, the local runner starts a disposable Docker `postgres:17` container with a unique name and free loopback port, waits for readiness, and removes the container and its volume afterward. If Docker is unavailable, it fails with instructions to enable Docker or explicitly supply a disposable `TEST_DATABASE_URL`. It does not load `.env`, use the application's `DATABASE_URL`, skip absent infrastructure, or substitute in-memory storage. It creates a random database schema, applies the production migrations, and drops that schema afterward. Application and evidence directories are temporary directories under `/tmp/opencode` and are removed after verification. An explicitly supplied test database is not deleted or stopped; never target production or shared demo data. The separate live-provider harness retains its explicit credential/database requirements.

## Exercised Path

Three scenarios use the fixture manifest's immutable SHAs:

| Scenario | Exact Commit | Expected Report |
| --- | --- | --- |
| Broken checkout | `05d773013cc4d9beeeba8cea513fc108f659cd28` | `completed`, `failed`, PNG/network/log evidence |
| Fixed checkout | `e0c69bf8dba700d5a8e5a48ebbc504b7064a3575` | `completed`, `passed`, two declined requests |
| Startup process exits 23 | `e0c69bf8dba700d5a8e5a48ebbc504b7064a3575` | `error`, `environment`, no outcome |

The tests exercise the production HTTP authentication and submission/status endpoints, Postgres run/job storage, `executeNextJob` queue claiming and terminal persistence, the real Chromium checkout verifier, durable `EvidenceStorage`, and authorized evidence downloads. They verify queued/preparing/verifying/terminal reports, exact detached Git HEAD, setup execution, failure screenshot signature and diagnostic content, cleanup, finished jobs, and report/evidence access after restarting the API and database pool. Unauthenticated submissions, status reads, and evidence reads are rejected.

## Limitations

This is an explicit **local test execution adapter**, not a Freestyle VM mock that returns canned outcomes, and not a live-provider test. The callback checks out the real Git revisions and runs real fixture processes and Chromium on this host. It replaces the VM/executor boundary and performs artifact collection in the test; it does not validate Freestyle networking, snapshots, guest deployment, artifact transfer, or VM deletion.

The standalone production worker now consumes persisted submissions using `backend/src/executor.ts`. Its server-owned project allowlist enables only `checkout-fixture` and the manifest's two SHAs. The executor creates a Git bundle from the local fixture, transfers actual Git objects to the VM, fetches the submitted SHA and verifies detached HEAD before executing setup. No public repository, push, repository credentials, or custom snapshot is required. The built guest runner is transferred separately without `.env` or host dependencies; dependencies and Chromium are installed on `freestyle/ubuntu-sm` using the current documented API. The ten-minute execution budget, command deadlines, bounded evidence collection/deletion, and provider TTL/runtime limits cap each run.

Five production executor SDK-boundary tests additionally exercise real host-side Git bundles and runner archives, passed/failed terminal reports, startup exit, revision mismatch, toolchain failure, and durable evidence before/after deletion. Provider responses are injected in these tests: they are not live VM verification. Freestyle adapter tests also cover worker cancellation and cleanup.

Local and injected-SDK tests alone do not prove the provider path. On 2026-10-03, after Noel supplied an authorized API key in `backend/.env`, all three separate live scenarios passed through the standalone production worker. This verified guest installation, provider file transfer, browser execution, evidence transfer, and provider-confirmed VM deletion. Credentials were loaded without printing or copying them to guest artifacts.

## Standalone Setup

Install backend dependencies (`npm --prefix backend ci`) and build the guest runner before starting either a source or compiled worker (`npm --prefix backend run build`). Keep `fixtures/checkout` as a real Git repository containing the manifest commits; the runtime needs it and `fixtures/checkout-revisions.json` alongside `backend/`. API and worker must share Postgres and an absolute `EVIDENCE_DIRECTORY` on persistent storage outside the VM.

Provide `DATABASE_URL`, `DEMO_TEAM_TOKEN`, `FREESTYLE_API_KEY`, and optionally `HOST`, `PORT`, and `EVIDENCE_DIRECTORY` as server-side environment variables. `DEMO_TEAM_TOKEN` must be a securely supplied 32-256 character base64url token. Do not copy either token or database credentials into the VM. The API/worker/migration package scripts run in `backend/` and load `backend/.env` if present; exported environment variables work as well. The example file contains placeholders, not usable credentials.

```sh
npm --prefix backend run migrate
npm --prefix backend run build
npm --prefix backend run start:api
# In a separate terminal with the same server-side environment:
npm --prefix backend run start:worker
```

Submit each exact manifest SHA to `POST /submissions` with `Authorization: Bearer <demo-team-token>` and the JSON body below. Do not supply repository URLs, commands, or credentials in requests. Poll the returned `Location` (`GET /runs/<runId>`) using the same authorization. Authorized artifacts are available at `GET /runs/<runId>/evidence/<evidenceId>` for each returned evidence reference.

```json
{
  "projectId": "checkout-fixture",
  "commitSha": "05d773013cc4d9beeeba8cea513fc108f659cd28",
  "requirementId": "declined-payment-retry"
}
```

Repeat with the fixed SHA from the table. A provider/startup/tooling error must have state `error` with no outcome; it is not a failed product requirement. The local startup-error scenario injects a process exit without modifying the submitted revision; it is not a public request-controlled startup command.

## Opt-In Live Verification

With an authorized exported `FREESTYLE_API_KEY` and a disposable `TEST_DATABASE_URL`, run `npm --prefix backend run test:live`. This command builds the runner, then executes three sequential real-provider scenarios with authenticated HTTP, Postgres, and a separately spawned production worker. It refuses missing credentials rather than skipping tests or substituting local execution. It does not load `.env`, log credentials, create snapshots, publish repositories, or create API keys.

Each scenario uses an isolated database schema and runtime directory. Startup failure is induced through a temporary server-owned fixture manifest with `node -e 'process.exit(23)'`, not through request input, Git changes, or a production fault-injection switch. A sanitized startup-exit event prevents unrelated provisioning errors from satisfying this scenario. VMs have unique run-associated slugs (`verification-<runId>`); the harness requires provider-confirmed deletion (404, not an arbitrary transport/auth failure) before downloading authorized evidence. Failure screenshots, diagnostic JSON, exact report SHA, finished queue jobs, and unauthorized artifact rejection are checked. A failed test also attempts explicit VM deletion, stops its worker, and removes the temporary schema/runtime; provider TTL remains a fallback for late provisioning.

Budget: at most three sequential Ubuntu small VMs, ten minutes execution per VM plus bounded evidence/cleanup, approximately 34 minutes maximum suite runtime. The successful 2026-10-03 suite took approximately 97 seconds. The three VMs, isolated schemas, workers, and disposable Postgres container were cleaned up.

To use `backend/.env` without exporting or printing its secrets, build first and run the harness directly with Node's environment loader. `TEST_DATABASE_URL` must still identify a disposable database, supplied server-side:

```sh
npm --prefix backend run build
LIVE_EVIDENCE_DIRECTORY="$PWD/.data/live-verification" node --env-file=backend/.env --test backend/tests/verification.live.mjs
```

`LIVE_EVIDENCE_DIRECTORY` is optional. When supplied, the harness retains private copies of the validated report and artifacts downloaded after VM deletion. Temporary database schemas and runtime directories are still deleted. Do not serve this directory publicly or commit its contents.

## Live Results

See [the human-readable live report](live-verification-report.md) for per-scenario findings, actual diagnostic observations, and links to retained artifacts. Reports are backend JSON records; the harness does not create a frontend report screen.

| Scenario | Run ID | Verified Result |
| --- | --- | --- |
| Broken | `4ee43442-bc18-452d-a94d-07228644ab25` | `completed/failed`, PNG/network/log evidence |
| Fixed | `9382fa90-0088-4606-b92c-7fe2045811df` | `completed/passed`, two POSTs receiving 402 |
| Startup exit | `9d67a602-cab3-4172-8f8e-8a033f002805` | `error/environment`, no outcome |

Each report retains the corresponding exact commit from the scenario table above. All three VMs were confirmed absent by a provider 404 before evidence retrieval; unauthenticated artifact requests returned 401. Startup failure was confirmed by the real startup-exit diagnostic, not an unrelated environment error. The retained reports and downloaded artifacts are under `.data/live-verification/<runId>/`.

The broken screenshot is blank because that revision removes the checkout contents after the declined payment. Its structured log identifies `requirement-failed` at `declined-error`. The fixed network evidence records exactly two `POST /checkout` observations with status 402, proving the retry submitted again. Startup failure has no check outcome or browser evidence because application readiness was never established. Noel Bobby reviewed and approved these results on 2026-10-03, completing the final plan gate; passing this single requirement does not establish successful payments, mobile layout, or payment idempotency.

## Verification Commands

```sh
npm --prefix backend run typecheck
npm --prefix backend test
# Docker provisions disposable Postgres, or supply your own TEST_DATABASE_URL:
npm --prefix backend run test:integration
npm --prefix backend run test:e2e -- verification
npm --prefix backend run test:fixture
npm --prefix backend run build
```

The integration script builds the deployable guest runner before running tests. The 2026-10-03 verification used a temporary Docker Postgres 17 database and cleaned it up afterward; all three local end-to-end scenarios and all three separate live-provider scenarios passed.
