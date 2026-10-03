# Paper / Field

## Company Backstory

Paper / Field is a fictional three-person stationery company. It started as a small studio selling clothbound notebooks at weekend markets and through a handful of local bookshops. Customers kept asking to order online, so the team is launching its first direct-to-customer store.

The first collection has one hero product: the forest-green Everyday Notebook, priced at $12. Keeping the launch small lets the team focus on getting the buying experience right before expanding the catalog.

Launch emails are ready, the first batch of notebooks is packed, and the team is doing the final checkout handoffs. Each person has their own work, but nobody can finish the launch alone.

This is a fictional scenario for the hackathon. The checkout uses sandbox responses and never charges a card or fulfills an order.

## Your Roles

| Person | Company Role | Owns | Depends On |
| --- | --- | --- | --- |
| Aryan | Storefront Engineer | Build the customer-facing checkout, loading state, visible payment errors, and retry interaction | Noel's documented payment response contract |
| Noel | Commerce Engineer | Provide the checkout API contract and finish connecting the storefront to the commerce flow | Aryan's UI correctly handling that contract |
| Kiran | Product & Launch Lead | Define launch acceptance criteria, review the integrated experience, and coordinate the launch decision | Aryan and Noel completing their handoff with evidence |

Kiran's role is an active downstream responsibility, not just narrating the demo. Noel cannot call commerce integration ready if the UI drops failures; Kiran cannot call the launch ready if Noel's integration is still blocked.

## Shared Launch Contract

Milestone: **Everyday Notebook online launch**.

The demonstrated requirement is deliberately narrow:

> If POST /checkout returns PAYMENT_DECLINED, checkout must show "Payment declined. Please try again." and allow the customer to retry.

Aryan implements the behavior. Noel relies on it during integration. Kiran owns its acceptance for launch. Kudos checks the behavior before Aryan's work is handed to Noel.

Other launch responsibilities can appear as team context, but this demo does not prove successful payments, inventory, order fulfillment, mobile correctness, or idempotency. A passing result authorizes this handoff, not the whole company's launch.

## The Team Story

1. **Kiran sets the milestone:** "We're taking Paper / Field online. Aryan owns checkout, Noel owns commerce integration, and I own launch sign-off. Our work depends on each other."
2. **Aryan claims completion:** "The checkout looks good. My part is done. Sending it to Noel."
3. **Kudos checks the shared requirement:** It tests a declined payment on the broken checkout. The screen goes blank, so it blocks the handoff with evidence.
4. **Noel explains the dependency:** "My API can decline a payment. If the UI disappears, I can't finish this integration without sending it back."
5. **Kiran makes the impact concrete:** "And I can't sign off the customer experience while that's unresolved. One missing state holds up the next two people."
6. **Aryan fixes the missing behavior:** "I missed the error and retry state. Let me add those." Apply the prepared fix or clearly explain the revision switch.
7. **Kudos reruns the same check:** The fixed checkout shows the decline and permits another request. The handoff is authorized.
8. **Noel receives the report:** "Now I have the revision, the requirement, and the verification evidence. I can continue integration."
9. **Kiran closes:** "That's the point of Kudos: catch unfinished work before the next person builds on it."

## Live Presentation: About Three Minutes

| Time | Speaker | Beat |
| --- | --- | --- |
| 0:00-0:20 | Kiran | "Ever heard 'I'm done' and then spent your afternoon finishing someone else's work?" Introduce Paper / Field's first online launch. |
| 0:20-0:40 | All three | One sentence each on their role; show Aryan -> Noel -> Kiran and the shared requirement. |
| 0:40-1:20 | Aryan | Attempt the handoff; show Kudos's real declined-payment check, blank screen, and block. |
| 1:20-1:40 | Noel and Kiran | Explain the integration dependency and launch sign-off consequence. |
| 1:40-2:20 | Aryan | Apply the prepared fix, rerun, and show the error and retry behavior passing. |
| 2:20-2:45 | Noel | Receive the verified report and explain what he can now continue. |
| 2:45-3:00 | Kiran | Close: "Before your work becomes someone else's problem, Kudos verifies it." |

Measure actual verification time during rehearsal. Label recordings or preverified results if needed; do not present them as live execution.

## Judges' Video: Target 2:40

Use the same company and team story, with less dialogue: 20 seconds for company/roles, 20 for the shared contract, 45 for the blocked attempt and evidence, 35 for the fix and rerun, 25 for Noel's report and Kiran's dependency, and 15 for the close. Label time cuts and explain that payment declines are deterministic sandbox test cases.

## Demo Assets

- Polished broken checkout: port 4176, source `fixtures/checkout-broken`.
- Polished fixed checkout: port 4175, source `fixtures/checkout`.
- Company roles and handoff metadata: `fixtures/checkout-handoff.json`.
- Technical runbook and revision caveats: `docs/checkout-demo.md`.

The two polished pages look identical before Pay. The only functional difference is whether a failed payment leaves a blank checkout or a visible error and retry. This session maintains the mock and story; Kudos team screens and handoff mechanics remain owned by the product sessions.
