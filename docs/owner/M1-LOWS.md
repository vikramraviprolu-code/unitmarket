# M1-LOWS tracker: low findings of the POB-M1 reviews

Lane M1-LOWS, branch `feat/payments-m1-lows`, spec `docs/specs/payments-m1-lows.md`. Checked against main 660bb62b (M1 merged in #56, payee work of POB-G included). Line numbers are of this branch after the review follow-up (second round, below each finding as "Review follow-up"). No migration was written. Nothing here touches PayPal or any hosted system, so nothing was checked against a hosted database.

Status words: `fixed/tested` (changed and covered by a test that failed before), `pinned/tested` (behaviour kept on purpose, documented, covered by a test that passes before and after), `proposed` (deferral, needs an owner decision or a migration, nothing built).

| Id  | Verdict on main                                      | Action                                     | Status                               |
| --- | ---------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| L1  | still open, accepted, alert is the only guard        | comment in code, behaviour pinned          | pinned/tested                        |
| L2  | still open, unreachable today                        | RangeError handled like a ledger rule      | fixed/tested                         |
| L3  | not reachable through product paths                  | pinned; relax of CHECK not needed          | pinned/tested                        |
| L4  | still open, not reachable with the dry run port      | harden settle and the pass loop            | fixed/tested                         |
| L5  | still open (label wrong, figure as designed)         | label and source line changed              | fixed/tested                         |
| L6  | still open (needs a migration)                       | deferral                                   | proposed                             |
| L7  | still open (needs an owner decision)                 | deferral                                   | proposed                             |
| L8  | still open (text wrong; exit from `sending` missing) | alert text and reason fixed; exit proposed | fixed/tested (text), proposed (exit) |
| L9  | moot for product code (test support only)            | restore mode switched off after the load   | fixed/tested                         |
| L10 | still open as code, harmless                         | kept on purpose, comment and pin           | pinned/tested                        |

## M1-L1 booking of the refund parts refused by a ledger rule overpays a due payout

Finding: in `bookEntry` (POB-M1 hunk), if `bookRefundParts` throws `LedgerRuleError`, `payable_minor` is still passed to `onRefundBooked`. A due payout is cancelled and made again from a ledger net that has no reversal, which overpays by the refund's payable part. An alert is raised, so it was accepted.

Verdict: still open as described, and accepted. `domain/payments/src/refunds.ts:1100-1122` catches the rule error and raises `refund_unresolved` with reason `ledger_rule_split_<refund id>`; `payable_minor` is set at line 1103 before the booking and passed to `onRefundBooked` at line 1143. `onRefundBooked` (`payout.ts`) cancels a `due` or `failed` payout, and `dueUnits` then reads the payable net from the ledger. Reaching it needs a conflicting reversal row under the same refund id, which the product does not write.

What was done: no behaviour change (any change here moves money). The exposure is now stated in a comment at `refunds.ts:1090-1098`, and `payout.lows.state.test.ts` "M1-L1 pinned" injects a conflicting `payable_reversal`, books a 100 refund on a 400 sale with a due payout of 360, and pins: refund booked, one `ledger_rule_split_` alert, the payout cancelled and paid again at 359 (the ledger net), more than the 270 a clean booking gives.

Cheapest future fix, if the owner wants the exposure closed (no migration): in `dueUnits` (`payout.ts`) skip a unit that has an open `refund_unresolved` alert whose reason starts `ledger_rule_split_`, so an operator corrects the ledger before the unit is paid. Trigger that makes it matter: any change that writes reversal rows from another place, or a ledger repair tool. Risk until then: overpay of the payable part of one refund, visible as a high alert.

Status: pinned/tested.

## M1-L2 `splitRefund` is called outside the try

Finding: `splitRefund` (`domain/ledger/src/parts.ts:42`) is called outside the try, so its `RangeError` would abort the refund booking. Unreachable today because DB guards keep parts equal to the unit amount.

Verdict: still open, unreachable. `parts.ts:42-63` throws `RangeError` when the refund does not fit the parts; `order_unit_parts` has an insert guard that keeps seller plus fee equal to the unit amount (migration 0029 section 3) and the table is append only. Before the fix the call was at `refunds.ts` (line 1091 on main) outside the try, and a throw rolled back the booking of a refund PayPal had already made.

What was done: `splitRefund` is inside the try (`refunds.ts:1102`) and the catch takes `RangeError` as well as `LedgerRuleError` (`refunds.ts:1111-1112`). The refund is booked, the same `ledger_rule_split_` alert is raised, no reversal rows are written, the payout is not told (payable stays 0). Test `payout.lows.state.test.ts` "M1-L2" disables the parts trigger for the setup only, makes the parts smaller than the refund, and failed with `RangeError: splitRefund: the refund does not fit the unit` before the fix.

Review follow-up: the exposure is NOT the same as M1-L1. For a due payout both overpay by the refund's payable part. For a payout that has already gone out, M1-L1 books a `payout_adjustment` (the payable part is passed, so the claim on the publisher is kept and netted off the next payout), while M1-L2 books none (no split, payable 0), so the claim is lost and only the `ledger_rule_split_` alert is left. The comment in `refunds.ts` now says so. Note, not changed: the catch takes any `RangeError` thrown inside the try, which is broader than `splitRefund` alone; nothing else in that block throws one today.

Status: fixed/tested.

## M1-L3 a unit totalling 0 would roll back in `copyUnitParts`

Finding: `order_unit_parts.seller_minor CHECK (>= 1)` and `offer_price_parts` likewise; `MinorUnitsSchema` allows 0; an order whose unit totals 0 would roll back in `copyUnitParts`. Confirm a 0 total can never reach `placeOrder`, or relax the check (a migration).

Verdict: not reachable through product paths. `MinorUnitsSchema` allows 0 (`packages/contracts/src/primitives.ts:32`) but every write of an offer price goes through `checkPrice` (`domain/catalogue/src/write.ts:66-73`, `below_one` for a price under 1) in create and revise (line 264), and the web import publish (`import-publish.ts:108`, `:118`). The staged prices have `CHECK (price_minor >= 1)` (migration 0030). Seed data has positive prices. The table CHECKs are at `0029_fee_and_payouts.sql:47`, `:88` and `:284`. A 0 offer can only be written past the catalogue; then approval accepts it and `placeOrder` fails on `order_unit_parts_seller_minor_check` and the whole transaction rolls back (no order, no unit, no parts row).

What was done: nothing relaxed (a relax needs a migration and would also need a skipped payable row, which is a money change). Test "M1-L3 pinned" builds a 0 priced offer past the catalogue and pins the failure and the empty tables.

Trigger that would make it matter: a decision to sell free items. Cheapest fix then: a migration relaxing the three CHECKs to `>= 0`, `bookSaleParts` (`domain/ledger/src/parts.ts`) writing no `payable` row for 0 (the ledger forbids a 0 row), and `dueUnits` (`pay.net > 0` already skips such a unit). Until then, a clean refusal in `placeOrder` instead of a database error would be a code only improvement.

Status: pinned/tested.

## M1-L4 `settle()` is not in a try

Finding: `settle()` is not in a try. An accepted answer with an empty `provider_ref` breaks the CHECK and the throw aborts the rest of the pass. Cannot happen with the dry run port. Harden before a real port.

Correction of my first round text: the old code failed on the `provider_ref` CHECK (length 1 to 200) for the empty string only. For a blank reference such as `"   "` the CHECK accepts the spaces, so the old code stored the blank reference and marked the payout `sent` with no throw. The new check (`trim() === ''`) covers both.

Verdict: still open before this lane. `provider_ref` has `CHECK (char_length BETWEEN 1 AND 200)` (0029 payouts table) and `settle` used the answer unchecked; `sendPayouts` did not catch a throw from it. The dry run port always returns a reference (`payout-dryrun.ts`).

What was done, `payout.ts`: (1) `settle` (line 565) refuses to apply an accepted answer whose reference is empty or blank: the payout stays `sending`, counts as `errored`, one error log line, and the next pass sends it again with the same stored key. It is deliberately not failed, because the provider may hold it and a failed payout is paid again after 24 hours. (2) `sendPayouts` catches any throw from `settle` (line 681) and counts it `errored`, so the payouts after it are still sent. (3) The `sent` and `failed` counts now move after the commit, so a rolled back transaction is never counted. Test "M1-L4" (two publishers, reference `""` and `"   "`) failed before the fix (for `""` the pass rejected on the CHECK; for `"   "` the payout was stored and marked sent, so the expected counts differed); it now checks one sent, one errored, the first payout `sending` with no reference, and that a second pass with a good answer applies it with the same key.

Review follow-up:

- Test for the new try/catch in `sendPayouts`: "M1-L4: a settle that throws does not stop the payouts after it" gives the payout the pass reaches first an accepted answer whose status the `payouts` state CHECK refuses, so the transaction of `settle` throws. It asserts the pass resolves, the later payout is sent, the first stays `sending` with no reference, and the counts are `sent: 1, errored: 1` (the sent count moves only after commit). Local mutation check: with only the catch removed, this test failed (the pass rejected); the run of the three files showed 3 failed (this test and the two golden tests that were red on purpose) and 62 passed. With the catch restored it passes.
- PRECONDITION for any real payout port, now written in the comment in `payout.ts` (`settle`): leaving a blank-reference payout in `sending` relies on an unproven provider property, that a resend with the same idempotency key is answered with the same accepted answer, reference included. If a future port maps a duplicate key to `rejected`, `settle` marks the payout `failed`, `expireFailedPayouts` cancels it after 24 hours and its units are paid again under a new key: a real double payout. A port must report a duplicate key as the original answer, or as an error that throws (the payout then stays `sending`), never as a rejection. Not reachable today (only the dry run and the test spies exist). The port lane must prove this property with its own test before any sandbox payout.
- Still missing: an alert for a payout that stays in `sending` with a blank reference (planned reason `payout_noref_<id>`, kind `payout_failed`, with a catalogue text). Today an operator sees only the `errored` count and a log line (`payout.accepted_without_reference`). Cheapest fix: one `raiseAlert` in the blank-reference branch plus a catalogue entry, once the port lane exists.
- Note, cosmetic, not changed: the blank-reference branch runs before the transaction, so it does not check that the payout is still `sending`; the only effect is an `errored` count and a log line for a payout that was meanwhile settled elsewhere.

Status: fixed/tested.

## M1-L5 "Next payout" includes units still inside their window and held units

Finding: the statement "Next payout" (`moneyFor`, `unpaid`) includes units still inside their window and units held by a reversal that will never be paid; the label suggests the next payout.

Verdict: still open. The `unpaid` query (`domain/publisher-console/src/statement.ts`, `moneyFor`) sums the payable net of every unit not in a payout that went out, with no window or reversal test, unlike `dueUnits`. The number is useful (what the publisher is owed and not yet paid); the label was wrong.

What was done: the label is now "Owed, not yet paid out" and its source line says "...not yet in a payout that went out, less the open adjustments, never below zero. It includes sales still inside their access window and units held by a reversal." (`apps/web/src/lib/payout-copy.ts:85`, `:94`; the units held by a reversal were added in the review follow-up; D-051 checked by the existing golden test: no dash, no italics). The figure, the tile key `next`, and the field name `net_minor` are unchanged; the field comment in `statement.ts` says so. Golden tests `payout-copy.golden.test.ts` (two expectations) failed before and pass.

Deferred inside this finding, proposed: (a) the CSV row `total_next_payout` (`domain/publisher-console/src/csv.ts:102`, pinned by `csv-fee.test.ts`) keeps its name because it is a column contract for people who parse the file; rename to `total_owed_unpaid` only with the owner's word and a note to the publishers. (b) If the owners want a true "next payout" figure, filter the `unpaid` query to units whose windows ended and with no reversal (the `dueUnits` conditions); that changes a shown number.

Status: fixed/tested (label), proposed (CSV name, true next payout).

## M1-L6 the DB does not enforce that a `payout_items` unit matches the payout's publisher and currency

Finding: the domain enforces it, the database does not.

Verdict: still open, needs a migration. `payout_items` (`0029_fee_and_payouts.sql:281`) has foreign keys only. The one writer is the `INSERT INTO payout_items` at `payout.ts:406`, inside `makePayouts` (which starts at `payout.ts:332`), which takes units from `dueUnits` grouped by publisher and currency (`payout.ts:302-322`) under a lock on the publisher row; no other code inserts payout items.

What was done: nothing (hard boundary: no migration).

Deferral: risk is a wrong payee amount if a future writer breaks the grouping; today none exists. Trigger: any second writer of `payout_items` (a manual payout tool, an import). Cheapest fix: a new migration (next free number on main when written; 0030 is taken) with a `BEFORE INSERT` trigger on `payout_items` that raises unless the unit's `publisher_id` equals the payout's and the order currency equals the payout currency, and that lets the restore mode through like `ums_payout_insert_guard`; test in the `migration-NNNN.state.test.ts` style plus the restore test.

Status: proposed.

## M1-L7 D-096 (4) asks for a second operator or the owner for fee changes

Finding: the spec asks only for the second factor, which is implemented. Note it as a follow-up.

Verdict: still open, needs an owner decision. `setFee` (`domain/catalogue/src/fee.ts:139`) requires an operator with MFA (line 144) and a reason, and writes one audit event; it does not require a second person.

What was done: nothing built. Deferral: a change of the fee moves money for new sales only (D-096 (5)), is append only and audited, so the risk is one operator changing the fee alone. Trigger: more than one operator, or the fee going live beyond the sandbox. Cheapest fix: a two step action with no migration beyond one table: a pending fee change row proposed by operator A and applied by operator B or the owner (B is not A), or the owner flag in `setFee`. Needs the owner to say which of "second operator" or "owner only" applies and who is a valid second person.

Status: proposed.

## M1-L8 wrong alert text for a payout already `sending`

Finding: `prepare` also resumes payouts already in `sending`. If the publisher becomes inactive at that point, the alert says the payout "was not sent", but the provider may already hold it. The payout stays in `sending` with no way out and its adjustments wait forever.

Verdict: still open (text), and the missing exit is real. `prepare` (`payout.ts`, around 495-560) returns `refused` for a `sending` payout when the publisher is inactive, shared, has no payee or a changed address; it only cancels a `due` payout (line 539, POB-G). The catalogue text (`domain/alerts/src/catalogue.ts`) said "A payout was not sent".

What was done: a refusal of a `sending` payout now uses reason `payout_refused_<id>_<why>_sending` (`payout.ts:531`, plus `payout_state` in the detail), a separate alert from a refusal while `due`, and the catalogue (`catalogue.ts:246`) gives it its own cause: the provider may already hold it, it stays in sending, refunds booked on it wait, and it is sent again with the same key when the publisher can be paid. What is sent or cancelled did not change. Tests: `payout.lows.state.test.ts` "M1-L8" (reason, one alert for two passes, no extra send, and the same key sent once the publisher is active again; failed before on the reason) and `catalogue.golden.test.ts` "M1-L8" (failed before on the text).

Review follow-up: the runbook line of the `_sending` case was wrong too (it said to let the next pass pay again after the hold, but a sending payout has no hold). The catalogue runbook is now chosen by the reason (`catalogue.ts:253`): check with the provider whether it already holds the payout; a payout in sending has no hold and is never paid again under a new key; put the publisher right so the next pass can finish it with the same key. The golden test checks the due and sending runbooks differ and that D-051 holds.

Starvation note for the operator-exit decision: `sendPayouts` picks `WHERE state IN ('due', 'sending') ... ORDER BY created_at, id LIMIT max_items` (`payout.ts:659`), and the app passes `max_items: 100` (`apps/web/composition.server.ts` ~2912). Payouts stuck in `sending` are the oldest, so 100 or more of them would fill every pass and starve newer `due` payouts. Not reachable with a few publishers; it makes the operator exit (below) more urgent once there are many, or the pass should skip a `sending` payout it has just refused.

Not done, proposed: the exit. Today the exit is to make the publisher payable again, which resumes the send. If the publisher will never be payable (closed, address gone) the payout stays `sending` and the adjustments booked on it stay unnetted. Cheapest fix, no migration (the `sending` to `failed` and `sending` to `sent` moves already exist in `ums_payout_guard`): an operator action in Operations, MFA and a reason, "I checked with the provider": mark the payout `failed` (the units are paid again after the hold, to the verified address) or record the provider reference and mark it `sent`. It needs the owner to approve a new operator money action and its wording. Trigger: the first real payout that sticks in `sending`.

Status: fixed/tested (text and reason), proposed (exit).

## M1-L9 restore mode set outside `importSql`

Finding: `apps/web/src/search-support.ts` sets `{"mode":"restore"}` from non-test code. It inserts no payouts today, but a future payout insert there would skip the insert guard.

Verdict: moot for product code, still a trap for tests. `search-support.ts` is test support (its header says so); it is imported only by `*.test.ts` files and by `seller-fixture.ts`, which only tests import (searched `apps`, `domain`, `packages`). The mode comes from `set_config('ums.trace', ..., true)` at line 151, transaction local; the product sets it only in `packages/db/src/export-sql.ts:240` (`importSql`). The load inserts approvals, orders, provider orders and units, no payouts.

What was done: the script now switches the mode off again after its last insert (`search-support.ts:163`), so anything added after it, a payout insert included, meets the guard. Test `search-support.restore.test.ts` (fake `exec` that captures the SQL) pins: restore on first, off last and after the last insert, and no payout, settlement or adjustment text in the script. It failed before. `v1-export.state.test.ts`, which uses the seeder, still passes.

Status: fixed/tested.

## M1-L10 adjustments with no source row count as open

Finding: the fallback was only for rows booked before the sources table existed; none exist, so it can probably be dropped.

Verdict: still present (`payout.ts:262-283` `openAdjustments`, and the same rule in `statement.ts` `moneyFor`). Repo evidence for "none exist": the table is created in the same migration as the adjustments (0029, section 7b), and `onRefundBooked` writes the source in the same transaction as the adjustment. What could not be verified: whether any hosted database ever applied an earlier version of 0029 (it was edited in place before the merge); no hosted access in this lane.

Decision taken: not dropped. Dropping the fallback makes a source-less adjustment (a hand edit or a foreign restore) silently never netted, which loses money in the platform's disfavour with no alert. The fallback costs nothing when there are none. Instead the comment now says why it stays (`payout.ts:262-266`, `statement.ts`), and test "M1-L10 pinned" removes the source row of a real adjustment and pins that the next payout is still netted (300 of 400 after an adjustment of 100).

If the owner wants it dropped anyway: replace the `NOT EXISTS` in both queries by an `EXISTS` of a source payout in `sent` or `confirmed`, after confirming with Sakthi that no hosted adjustment lacks a source row (one read only query on the hosted database, which this lane may not run).

Status: pinned/tested.

## Owner decisions needed

1. M1-L1: should a unit with a `ledger_rule_split_` alert be held from payout until an operator resolves it? (code only change)
2. M1-L5: rename the CSV row `total_next_payout`, and do you want a true "next payout" figure? (shown numbers)
3. M1-L6: schedule the migration for the payout item trigger.
4. M1-L7: second operator or owner only, for fee changes.
5. M1-L8: approve an operator action to close a payout stuck in `sending`, and its wording.
6. M1-L10: is a one time hosted check for source-less adjustments wanted before the fallback is dropped, or does the fallback stay?
