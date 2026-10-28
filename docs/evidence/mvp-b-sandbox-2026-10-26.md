# MVP-B evidence: the real PayPal sandbox, one publisher (24 to 26 Oct 2026)

Status: MVP-B is closed except B-13 (fixtures from the real recordings, a reviewed pull request by Sakthi).
Source: the owner's own terminal and browser runs, the app log lines the owner pasted, and the conformance
`summary.md`. The run folder `calls.json` stays on the owner's machine (it was checked: no secret; it needs
`record:fixtures --synthetic-ids` before it is shared). No order id, merchant id, token or debug id is written
here. "Proves the modelled and observed cases only, not PayPal compatibility in general."

Approval basis: D-035 (scope `mvp_b_polling`, 2000 minor units per order, 300 calls a day, valid until
2026-10-26 23:59 UTC). Outbound switch stopped by the operator on 26 Oct 20:13 UTC after the work.
Build under test: main with the polling fixes BU-8 and BU-9 (`89a8b0d` on 26 Oct).

## The 13 checks

| Id   | Scenario                                                            | Expected                                                                                                                                               | Observed                                                                                                                                                                | Evidence                            |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| B-01 | One real order: create, approve, capture, read-back, library access | Item in the library only after a verified capture and a separate matching read-back; five-day window; receipt with fingerprint; stored label "Sandbox" | PASS. Two real purchases on 24 Oct (USD 1.25 and USD 2.50) and a third on 26 Oct (USD 4.50), all reached "Paid. Your item is in your library."                          | Owner screenshots and terminal logs |
| B-02 | Create replay with the same key                                     | Same PayPal order, no second order                                                                                                                     | PASS                                                                                                                                                                    | Conformance `summary.md`, 26 Oct    |
| B-03 | Capture replay                                                      | One capture                                                                                                                                            | PASS                                                                                                                                                                    | Conformance `summary.md`, 26 Oct    |
| B-04 | Capture before approval                                             | Refused cleanly, nothing charged                                                                                                                       | PASS                                                                                                                                                                    | Conformance `summary.md`, 26 Oct    |
| B-05 | Cancel, then abandon                                                | Order ends abandoned, not charged                                                                                                                      | Offline fixture only. On the real sandbox a stale order from a first attempt ended `abandoned_not_found` after the BU-9 fix and shows "Not charged" in the library      | Offline tests; 26 Oct app log       |
| B-06 | Kill switch in the middle of a purchase                             | Return page says paused, nothing charged; after resume the replayed return captures once                                                               | PASS on 24 Oct. Stopped from `/ops` while the buyer was at PayPal; the return showed "Checkout is paused"; after resume one `capture_order` answered 201                | Owner screenshots and log           |
| B-07 | Timeout on capture resolved by read-back                            | Read-back decides, one capture                                                                                                                         | PASS                                                                                                                                                                    | Conformance `summary.md`, 26 Oct    |
| B-08 | At most 6 PayPal calls for one order                                | 6 or fewer                                                                                                                                             | PASS on 26 Oct: 4 calls (`create_order` 200, `get_order` 200, `capture_order` 201, `get_order` 200); no polling while the buyer was at PayPal                           | App log lines, 26 Oct               |
| B-09 | No secret in logs or call records                                   | None                                                                                                                                                   | PASS: app log lines hold only operation names, status codes, correlation ids and PayPal debug ids; the conformance `calls.json` was searched for secrets and found none | App log, owner `grep` count 0       |
| B-10 | Fit cards honest                                                    | Cards show only what the data supports                                                                                                                 | Offline tests (visual dashboard not built)                                                                                                                              | Offline suite                       |
| B-11 | Both entry paths reach the same approval                            | Same approval                                                                                                                                          | Offline tests                                                                                                                                                           | Offline suite                       |
| B-12 | Injection set                                                       | No prompt injection changes a price or a payee                                                                                                         | Offline tests                                                                                                                                                           | Offline suite                       |
| B-13 | Real recordings become fixtures                                     | Reviewed pull request                                                                                                                                  | OPEN: Sakthi, `pnpm record:fixtures --synthetic-ids`                                                                                                                    |                                     |

Also passed: the payee echo gate (D-028 option c, D-036): PayPal echoes the owner's own merchant id.

## Findings from the real runs (all logged, none blocked closure)

1. Resume does not capture by itself: an order left awaiting the buyer completes only when the return is replayed.
2. Safari cannot sign in over plain http (Secure `__Host-` cookie); Chrome Incognito works on localhost.
3. The conformance suite polled every 3 s and used the whole 300 call daily budget over reruns: fixed by BU-8 (15 s, 24 reads). A second storm of `get_order` 404 calls on a stale order (115 calls in 100 s) was fixed by BU-9 (abandon on not found, slow rhythm when nothing progresses). Both are merged; the 26 Oct restart made one 404 call and one abandon, then no calls.
4. After a `git pull` the app must be rebuilt (`next start` serves the old `.next`); a stale build gave an internal 500 on checkout. The local owner steps must say "rebuild after every pull" (to be added).
5. PayPal checkout language follows the account country (German); a locale hint is a later improvement.

## Known residuals (not fixed, listed in `docs/READINESS.md` follow-ups)

No per-order backoff for orders PayPal answers with an error other than 404; boot recovery is not budgeted;
the job loop has no fallback when its counts are unreadable.

## Closure

All checks are PASS or accepted offline except B-13. Finish steps: the PayPal switch is stopped; the cloud
copy of the PayPal client credentials is kept for the hosted window (the hackathon rules, as PA read them,
ask for a runnable demo until 15 Dec); the client secret is rotated at the end of the credentialed phase.
