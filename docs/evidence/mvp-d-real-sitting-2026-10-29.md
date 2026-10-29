# MVP-D evidence: the real two-publisher sitting (29 Oct 2026)

Status: the pack paid correctly at PayPal as two separate payments. Three owner confirmations are still open
(listed under Open confirmations), so the row for the full D-01 real half is PASS WITH CONFIRMATIONS OPEN, not
a clean PASS. A row is PASS only when the owner's own run was seen by the coordinator (screenshot or terminal
output, no secret, no raw id). "Proves the modelled and observed cases only, not PayPal compatibility in
general."

Approval basis: D-057 (scope `mvp_c_refunds`, five operations `oauth_token`, `create_order`, `get_order`,
`capture_order`, `get_capture`, 2000 minor units per PayPal order, 60 calls a day, valid until
2026-10-30T01:00:00Z). Start earlier than the written window: D-060 (owner, Sakthi present). Wrong database
before the sitting: D-059. Code under test: tag `mvpd-sbx-1`. Where: the owner's laptop, app on
`http://localhost:3000`, database `pglite-disk` in a fresh data folder, webhook off, no refund in this sitting.
The hosted app was stopped (connect flag off, kill switch off since 18:10 UTC) and was not used.

## Timeline (UTC, from the terminal and the screens)

| Time  | What                                                                                      |
| ----- | ----------------------------------------------------------------------------------------- |
| 17:57 | First `safety:approve` and `safety:resume` went to the hosted database by mistake (D-059) |
| 18:10 | Hosted switch turned off again with `safety:stop`                                         |
| 18:14 | Approval D-057 recorded and `paypal_outbound` turned on in the laptop database            |
| 18:17 | App running, `/ops` showed all five locks open and 60 of 60 calls (before any order)      |
| 19:03 | Pack paid: two payments in the Business account, receipt issued                           |
| 19:14 | `safety:stop` at the owner's terminal: `paypal_outbound=off`                              |

## Checks and what was seen

| Check                                                        | Result             | What was seen                                                                                                                         |
| ------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Step 2 approval row and switch                               | PASS               | `safety:status` showed `db=pglite-disk`, `paypal_outbound=on`, `60 of 60`, per-order cap 2000, the five operations, valid until 01:00 |
| Step 3 `/ops` before the pack                                | PASS               | five locks yes, `PayPal calls: allowed by the five locks`, the shared payee line, label Sandbox, no orders, all invariants hold       |
| Step 4.1 pack approval page                                  | PASS               | two blocks (Harbour $0.40, Quayside $0.90), the text "2 payments", total $1.30, frozen price with a countdown                         |
| Step 4.2 PayPal address starts with the sandbox host         | NOT SEEN           | the owner did not show it to the coordinator                                                                                          |
| Step 4.3 "Step 2 of 2" page and no payment between approvals | NOT SEEN           | no screenshot; the owner has not said whether the Business tab was empty between the two approvals                                    |
| Step 4.5 order page, library, receipt                        | PASS               | order page "ready in your library" for both items, library with two entries, receipt total $1.30 (see findings F1 and F2)             |
| Step 5.1 PayPal Business activity                            | PASS               | two separate Completed payments, 0.90 USD and 0.40 USD, same minute (20:03 CET); not one payment for the sum                          |
| Step 5.2 `/ops` order row                                    | PASS               | one order, status `paid`, total $1.30                                                                                                 |
| Step 5.3 call budget                                         | PASS WITH A REASON | 47 of 60 left, 13 calls used (12 expected); 44 to 47 is accepted when a reason is noted                                               |
| Step 6 finish                                                | PASS               | `safety:stop` then `safety:status`: `paypal_outbound=off`, 47 of 60                                                                   |

Reason for the 13th call (probable, not verified in the log): the return page reads the order again on every
render, and the owner reported clicking twice at one point.

## Open confirmations (the owner)

1. The address bar started with the sandbox PayPal host on both approval pages (yes or no).
2. Between the two PayPal approvals the Business account showed no payment for this pack (yes, no, or not looked at).
3. The two clicks: the second click was the "Step 2 of 2" button (yes), or one button needed two clicks (a finding).

## Findings (none blocks the next step)

| Id  | Finding                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The receipt reads "Version 2". The owner steps said one version. A new version is issued each time a capture is applied and the content changes, so version 1 is probably the receipt after the first capture. Not checked for this order. Owner steps wording to correct. |
| F2  | The receipt page in the app lists article ids and no publisher names. The downloadable receipt text names the publisher; the page `apps/web/src/app/receipts/[order]/page.tsx` does not use that field.                                                                    |
| F3  | The library says "4 days 23 hours left" and "5 days left until ..." on the same card. Redundant.                                                                                                                                                                           |
| F4  | `/ops` shows the order reference in full. Checkout pages shorten ids to the last 6 characters; `/ops` does not.                                                                                                                                                            |
| F5  | On the results page the button "Choose this article" starts a single purchase; a pack needs the Select boxes and "Buy selected together". The owner took the single path first. No charge was made.                                                                        |
| F6  | The order page sentence lists the Quayside item first and the list below lists the Harbour item first. Cosmetic.                                                                                                                                                           |
| F7  | Sign-in with a wrong passcode, name or code shows one message, so the cause cannot be told. A stop done with no name is recorded as `operator:opr_demo`.                                                                                                                   |
| F8  | A terminal that holds `DATABASE_URL`, `UMS_DB` or `UMS_PAYPAL_CONNECT` overrides `.env.local` silently (D-059). The safety tool and the app should refuse a mismatch. Follow-up lane.                                                                                      |

## Not tested for real in this sitting (offline only)

A real decline (D-02, fixture only), stopping between the two captures, a refund of one publisher of a pack,
the 60 minute pack window running out, a second pack, and the webhook for a pack.

## Gate condition C5

Closed: the owner inserted the approval row himself at his own terminal (D-057, laptop database). The first
insertion reached the hosted database by mistake and was undone as far as possible (D-059); the hosted copy of
D-057 stays there until 2026-10-30T01:00:00Z with the hosted connect flag off.

## Owner follow-ups

Delete `apps/web/.env.local` (the copy for the build). Answer the three confirmations. Sakthi reviews this note.
