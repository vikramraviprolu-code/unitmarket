# Enhancement requests

Requests from the owners that are not defects. Each row says who asked, when, what was asked, and what is known. Nothing here is scheduled until an owner says so.

| Id    | Date       | Asked by | Request                                                                                                                                                                       | State            |
| ----- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| ENH-1 | 2026-10-31 | Sakthi   | Make starting the PayPal sandbox gateway simpler, so that testers can be started without a developer. The owner does not call the current steps a defect, but an enhancement. | Open. See notes. |

## ENH-1 notes

What exists today: every deploy leaves the PayPal connection off. Starting it takes four human steps: an approval row inserted at the operator's own terminal with `safety:approve`, the switch turned on with `safety:resume`, the environment flag `UMS_PAYPAL_CONNECT=on` set on the Cloud Run service, and a check on the Operations page. The approval basis is D-062 (hosted app only, five operations, 2000 minor units per order, 120 calls a day, no refunds, no named payee, valid until 2026-11-03T12:00:00Z). The steps are in `docs/owner/MVPC-OWNER-STEPS-GCP.md`, Step I.

Why it is hard to simplify: the two-key approval (`docs/design/architecture.md` section 7, CLAUDE.md absolute rule 2) requires that the approval row is inserted by the owner at a terminal that refuses CI and agent sessions. A button on a web page that turned the gateway on would remove that key. Any simplification therefore needs an owner decision on which key may move.

Options to discuss (none decided, none built):

1. A single checked script for the owner's terminal that runs the four steps in order and prints the result (keeps the keys, saves typing).
2. A screen on the Operations page that shows exactly what is missing (approval row, switch, flag) and the command to run for each, without being able to change anything.
3. A start button on the Operations page that only turns the switch on when an approval row already exists (the approval row stays a terminal step).
4. A time-boxed "sitting" with an expiry, so the gateway turns itself off after a set time.

Wording to confirm with Sakthi: "so that I can start people" was read as "so that testers can be started". If something else was meant, correct this row.
