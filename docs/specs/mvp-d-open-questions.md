# MVP-D decisions: decided by the coordinator, and open for the owner

Revision 2, after the Opus review of 0e3730a. Table A lists questions the coordinator closed under existing decisions. Table B lists what only the owner can decide, each with a recommendation, what it changes, and which lanes it blocks. Every answer in B becomes a row in `docs/decision-log.md`, and DP-6 adds the matching ASSUMPTIONS row. Nothing here authorises a PayPal call.

## A. Decided by the coordinator under existing decisions

| Id    | Decision                                                                                                                                                                                                                                   | Basis                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| OQ-3  | A, eager create. `beginCheckout` creates every PayPal order of the pack before the buyer goes to PayPal. A refused create fails the whole order before any approval.                                                                       | D-3 (architecture), D-007: D2 under one UnitMarket approval.                            |
| OQ-4  | B. Nothing is captured until every PayPal order of the pack is approved. The pack approval window applies: 60 minutes from the first approval, then the whole pack is abandoned and nothing is charged.                                    | One approval covers the pack; ASM-75 (UNVERIFIED validity of an approved order).        |
| OQ-5  | A. A "Step 2 of 2" page with one button to the next approval; no automatic redirect.                                                                                                                                                       | Clear consent per payment; P16-style honesty of what happens next.                      |
| OQ-6  | A. Abandonment after the first approval charges nothing (pack window or 24 h sweep). Once any capture was sent, the pack is never abandoned: the continuation finishes it (DP-2b).                                                         | P17; review H2.                                                                         |
| OQ-7  | Keep-what-worked is the default by doing nothing. A refund goes only through the buyer's existing `refund_requested` report and an operator's MFA refund. There is no buyer choice API and no 7-day rule (cut).                            | Architecture 4.5 "never charge for a retry"; CO-8 refund route; the minimum viable cut. |
| OQ-9  | A. One 15 minute approval for the whole pack, consumed once by `placeOrder`.                                                                                                                                                               | `approvals` CHECK, `0004_money.sql:19`.                                                 |
| OQ-10 | A. Refunds per publisher unit; a whole-pack refund is two refunds; a partial refund never revokes.                                                                                                                                         | ASM-61, accepted in D-039.                                                              |
| OQ-11 | A (one library entry per item); "Bought together with" is cut to the later list.                                                                                                                                                           | Entitlements are per item.                                                              |
| OQ-12 | A. At most 2 publishers per approval (`too_many_publishers`).                                                                                                                                                                              | Journey and test matrix; the plan names two publishers.                                 |
| OQ-14 | A, plus M2. One pass reads and matches every PayPal order before the first capture. Any mismatch, duplicate invoice or item that is not ready stops the whole pack with nothing captured. After a capture, only that PayPal order is held. | P5; D-05 per-unit freezing after capture.                                               |
| OQ-15 | A, plus M4. A third fictional US publisher in a supplementary seed block, applied idempotently on every boot with its own ids.                                                                                                             | Keeps every base seed id and the GBP case for D-07.                                     |
| OQ-16 | A. One receipt per UnitMarket order; each line states its publisher and outcome.                                                                                                                                                           | One approval, one order, one receipt.                                                   |
| OQ-17 | A. Multi-select on `/discover`, using the existing `proposal` selection.                                                                                                                                                                   | PAY-10: both entry paths reach the same approval screen.                                |

## B. Owner decisions needed

**OQ-1: payee setup.** Blocks DP-1, DP-5 and the DP-6 owner steps.

Recommendation **B**: both publishers are paid into the owner's own sandbox Business account, with the scoped `payee_shared` flag (migration 0010).

- What B proves: two PayPal orders, two buyer approvals, two captures and two capture ids into one sandbox account; the order state machine; invoice ids per PayPal order; partial handling. D-01 is met as written.
- What B does not prove: payment to a merchant other than the API caller, the `PAYEE_NOT_CONSENTED` risk, separate settlement, or real onboarding (P18).
- The demo and the evidence must say: "Two publishers settled as two PayPal orders into one test merchant account; multi-merchant payout not demonstrated."
- A (a second sandbox merchant account) is a stretch item after the deadline. It needs runbook step 16 first and the owner's permission under D-023 (no new accounts unless decided).

**OQ-2: spike step 16 first?** Only if OQ-1 = A. Recommendation: yes. D2 with a third-party payee can hit the same consent error as W11.

**OQ-13: outbound approval for the MVP-D run.** Blocks the DP-6 owner steps.

Recommendation: reuse scope `mvp_c_refunds`. There is no change to `SCOPE_OPERATIONS`, `PAYEE_SCOPES` or `SCOPE_CURRENCIES`, so the ASM-70 seal freeze holds. A new row is needed anyway: `approval_ref` is unique (ASM-51) and D-035 expires 2026-10-26. For a local D-01 run, `mvp_b_polling` is the narrower scope, because it refuses any payee that D-028 does not leave out. On the host, `UMS_OUTBOUND_SCOPE` is pinned to `mvp_c_refunds` (`scripts/check-hosting.mjs:74`). The real D-02 decline stays fixture-only: the transport header allow-list (`sandbox.ts:126-132`) drops `PayPal-Mock-Response`.

The new row must state:

- its id;
- the scope;
- the operations, listed explicitly: `oauth_token`, `create_order`, `get_order`, `capture_order`, `get_capture`. Add `refund_capture` and `get_refund` only if a real composite refund is in the sitting. Add `verify_webhook_postback` and `fetch_webhook_cert` if the hosted webhook must keep working, because only one approval ref is active at a time;
- the cap **per PayPal order** (for example 2000 minor units), with the plain statement that the pack total is not enforced by the gate (`gate.ts:77` checks each call) and is bounded only by 2 x the cap;
- calls per day;
- a short `valid_until` covering one sitting;
- the operator;
- the payee mapping: "both publishers paid into the owner's sandbox Business account (…last 4), payee left out (D-028); any create body naming a payee is a stop";
- the buyer: the Personal sandbox account;
- "D-02 real decline not attempted";
- that it supersedes the MVP-C row for the window;
- that the kill switch, `UMS_PAYPAL_CONNECT`, `safety:approve`, `safety:resume` and `safety:stop` are unchanged;
- references to D-028, D-029, D-035 and D-037.

**OQ-18: the P18 record.** Blocks DP-1.

Recommendation: accept that P18 is satisfied by the `payee_verified_at` column (with `paypal_merchant_id`), set by an operator or a seed step and audited. This replaces plan lane D-L3. Under OQ-1 = B, the Quayside "verification" is a fiction and the evidence says so.

**OQ-8: buyer wording** (after the H1 edit). Blocks DP-3 (message) and DP-5 (copy golden).

Recommendation: accept the following:

- Partial message, used only when a payment was declined, failed or abandoned: "Part of your order did not go through. <ready> are ready in your library. You were not charged for <failed>. If you would rather have a refund for what you paid, tell us on the help page."
- Hold line: "On hold while we check it." It is never "not charged".
- Step page: "Step 2 of 2: approve your payment to <publisher> at PayPal. If you do not approve within 60 minutes, the whole order is cancelled and nothing is charged."
- Cancel page: "You did not approve this payment at PayPal. Nothing was charged. If you approved another payment of this order, it will not be taken unless you approve the rest."
- Refund note: "A copy you already downloaded cannot be recalled."

**M7: real-Postgres race tests.** Blocks the DP-6 owner steps.

The ASM-55 waiver (real-Postgres race tests) and the ASM-66 waiver were granted for the MVP-C sitting only (D-040). The owner decides one of the following:

- (a) waive both again for the MVP-D sitting, with the connection off at its end; or
- (b) require the real-Postgres race tests before the real MVP-D run.

Recommendation: (a), because the app still runs one PGlite process and the composite adds no concurrent writer. Revisit before the app stays live.

## Lanes and the owner decisions they wait for

DP-1: OQ-1, OQ-18. DP-2a, DP-2b, DP-4: none. DP-3: OQ-8. DP-5: OQ-1, OQ-8. DP-6 owner steps: OQ-1, OQ-13, M7.
