# Live Verification Report

Executed on 2026-10-03 using real Freestyle VMs, the standalone production worker, authenticated HTTP, and disposable Postgres. This is a backend verification report, not a screenshot of a frontend report page.

Requirement: `declined-payment-retry` for project `checkout-fixture`.

| Scenario | Report | Evidence | VM Cleanup |
| --- | --- | --- | --- |
| Broken checkout | `completed/failed` | One declined POST; missing visible-error assertion; blank failure PNG | Provider-confirmed deleted |
| Fixed checkout | `completed/passed` | Two declined POSTs; visible-error and retry assertions passed | Provider-confirmed deleted |
| Startup failure | `error/environment`, no outcome | Real process exit before readiness; no browser check | Provider-confirmed deleted |

## Broken Revision

- Run: `4ee43442-bc18-452d-a94d-07228644ab25`
- Exact commit: `05d773013cc4d9beeeba8cea513fc108f659cd28`
- Observed network: `POST /checkout` returned synthetic status `402` once.
- Diagnostic: `requirement-failed` at `declined-error`.
- The checker submitted payment, observed the declined request, and could not find the required visible error. It stopped there; retry was not exercised for this revision.
- The screenshot is entirely white because the broken revision clears the checkout DOM after the decline. It is a real screenshot, but is not explanatory on its own. There is no retained before-payment screenshot to compare with it.

Retained files:

- [Raw report](../.data/live-verification/4ee43442-bc18-452d-a94d-07228644ab25/report.json)
- [Network observations](../.data/live-verification/4ee43442-bc18-452d-a94d-07228644ab25/ea8206c0-4a25-43dc-b449-2af5de0e812b.json)
- [Diagnostic events](../.data/live-verification/4ee43442-bc18-452d-a94d-07228644ab25/db7f3f21-aaa7-460f-a4b7-9b353aeb13ee.json)
- [Failure PNG](../.data/live-verification/4ee43442-bc18-452d-a94d-07228644ab25/e73616eb-f3c9-4473-b0ae-4a7ede51eddc.png)

## Fixed Revision

- Run: `9382fa90-0088-4606-b92c-7fe2045811df`
- Exact commit: `e0c69bf8dba700d5a8e5a48ebbc504b7064a3575`
- Observed network: two separate `POST /checkout` requests, both with synthetic status `402`.
- Diagnostic: `requirement-passed` at `retry`.
- The same checker confirmed the visible decline message, an enabled retry action, a second submission, and the visible decline message after retry.
- No success screenshot was captured; current screenshots are failure-only. Console-error categories accompanying the 402 responses do not by themselves indicate JavaScript exceptions or a failed requirement.

Retained files:

- [Raw report](../.data/live-verification/9382fa90-0088-4606-b92c-7fe2045811df/report.json)
- [Network observations](../.data/live-verification/9382fa90-0088-4606-b92c-7fe2045811df/e857ddd0-ae3c-496c-900d-46b12b5344c6.json)
- [Diagnostic events](../.data/live-verification/9382fa90-0088-4606-b92c-7fe2045811df/82d9af7c-1305-4b2c-98df-4c6a8dd65964.json)

## Startup Failure

- Run: `9d67a602-cab3-4172-8f8e-8a033f002805`
- Exact commit: `e0c69bf8dba700d5a8e5a48ebbc504b7064a3575`
- A temporary server-owned start command intentionally exited with code 23 without changing the submitted Git revision.
- The live harness observed the startup-exit diagnostic and required `error/environment` with no product outcome. An unrelated provisioning failure would not satisfy this test.
- [Raw report](../.data/live-verification/9d67a602-cab3-4172-8f8e-8a033f002805/report.json)

## Cleanup And Scope

The provider returned 404 for all three run-associated VMs before evidence downloads. Authorized downloads succeeded; unauthenticated downloads returned 401. The temporary database container, schemas, and workers were also cleaned up. Retained copies remain private under `.data/live-verification/`, outside the deleted VMs; links above refer to local workspace files and are not public artifact URLs.

Both the three-scenario live suite and the plan's three-scenario local end-to-end command passed. This establishes only the declined-payment/retry requirement for these exact commits. It does not establish successful payment processing, mobile layout, or idempotency. Noel Bobby reviewed and approved the verification slice on 2026-10-03; the final plan checkbox is complete.
