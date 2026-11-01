# Enhancement requests

Requests from the owners that are not defects. Each row says who asked, when, what was asked, and what is known. Nothing here is scheduled until an owner says so.

| Id    | Date       | Asked by | Request                                                                                                                                                                       | State                                                      |
| ----- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ENH-1 | 2026-10-31 | Sakthi   | Make starting the PayPal sandbox gateway simpler, so that testers can be started without a developer. The owner does not call the current steps a defect, but an enhancement. | Open. See notes.                                           |
| ENH-2 | 2026-10-31 | Sakthi   | Add a Start button next to the existing Stop button on the Operations page, for the next round of changes.                                                                    | Built 2026-11-01 (option 1, D-070). Needs the next deploy. |

## ENH-1 notes

What exists today: every deploy leaves the PayPal connection off. Starting it takes four human steps: an approval row inserted at the operator's own terminal with `safety:approve`, the switch turned on with `safety:resume`, the environment flag `UMS_PAYPAL_CONNECT=on` set on the Cloud Run service, and a check on the Operations page. The approval basis is D-062 (hosted app only, five operations, 2000 minor units per order, 120 calls a day, no refunds, no named payee, valid until 2026-11-03T12:00:00Z). The steps are in `docs/owner/MVPC-OWNER-STEPS-GCP.md`, Step I.

Why it is hard to simplify: the two-key approval (`docs/design/architecture.md` section 7, CLAUDE.md absolute rule 2) requires that the approval row is inserted by the owner at a terminal that refuses CI and agent sessions. A button on a web page that turned the gateway on would remove that key. Any simplification therefore needs an owner decision on which key may move.

Options to discuss (none decided, none built):

1. A single checked script for the owner's terminal that runs the four steps in order and prints the result (keeps the keys, saves typing).
2. A screen on the Operations page that shows exactly what is missing (approval row, switch, flag) and the command to run for each, without being able to change anything.
3. A start button on the Operations page that only turns the switch on when an approval row already exists (the approval row stays a terminal step).
4. A time-boxed "sitting" with an expiry, so the gateway turns itself off after a set time.

Wording to confirm with Sakthi: "so that I can start people" was read as "so that testers can be started". If something else was meant, correct this row.

## ENH-2 notes

Request: a Start button beside the Stop button on the Operations page, so an operator can turn the PayPal gateway on without a terminal. Stop already exists ("Stop PayPal now" with a reason).

What a Start button could safely do (proposal for the owners to decide, nothing built):

- It turns the `paypal_outbound` switch on, as `safety:resume` does today. It needs the operator's authenticator code, a reason, and typing the scope name, as the terminal command does.
- It works only when an active approval row already exists for the configured reference and has calls left. The approval row stays a terminal step (`safety:approve`), because the two-key rule needs the owner to insert it at a terminal that refuses agent sessions and CI.
- It refuses when the approval has expired, when the budget is used up, or when the connection flag is off.
- It writes an audit row and shows the new state at once.

What it cannot do: change the Cloud Run flag `UMS_PAYPAL_CONNECT`. The app has no permission to change its own Google Cloud settings, and it should not have one. Today the flag is the deploy-time lock that every deploy resets to off. So the owners need to decide one of two things:

1. Keep the flag as a separate lock, set from Cloud Shell. The button then only works after the flag is on, and the screen says which key is missing.
2. Leave the flag on permanently in the hosted settings and let the switch plus the approval row be the two keys. This weakens the rule that a deploy always leaves PayPal off, so it needs a written decision.

Recommendation: option 1, plus a screen that shows exactly what is missing (approval row, switch, flag), as in ENH-1 option 2.

Money path note: this touches the safety package and the Operations route. It needs an Opus review, adversarial tests (a buyer, a publisher, an operator without the code, a replayed request, an expired approval), and must be done before the money-path freeze on Mon 2 Nov or agreed as an exception.
