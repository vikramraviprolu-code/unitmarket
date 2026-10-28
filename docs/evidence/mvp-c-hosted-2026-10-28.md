# MVP-C evidence: the hosted PayPal sandbox window (opened 27 Oct 2026, in progress)

Status: OPEN (C-01 passed 28 Oct; C-06, C-07, C-10, C-13 open). This file is filled in as each check passes. A row is PASS only when the owner's own run was
seen (screenshot, terminal or log line, no secret, no raw id). "Proves the modelled and observed cases only,
not PayPal compatibility in general."

Approval basis: D-052 (scope `mvp_c_refunds`, 2000 minor units per order, 300 calls a day, valid until
2026-10-30 12:00 UTC). Host: Google Cloud Run (one instance, always on) with Cloud SQL Postgres (D-049).
Certificate pin: D-053. Webhook: 7 of 8 events registered (D-053). Redeploys on 27 Oct: `gcp-mvpc-1`, `gcp-mvpc-2`.

## The hosted checks (the five from mvp-plan.md)

| Id   | Scenario                                      | Expected                                                                                            | Observed so far                                                                                                                                                                                                                                                                                                                                                            | State |
| ---- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C-01 | One genuine PayPal webhook delivery           | Signature checked against the pinned certificate; log line with verdict `verified` and a 200 answer | PASS on 28 Oct. After a second real hosted purchase (tide table article) two `webhook.delivery` lines at 21:44:37 and 21:45:06 UTC: verdict `verified`, http 200, outcome `enqueued`. Two earlier lines (20:52 and 21:17 UTC) were refused with `bad_signature`, reason `cert_url`, http 400: unsigned or off-list messages (probably the dashboard simulator) are refused | PASS  |
| C-06 | Real partial refund, with the operator's TOTP | Refund booked once, entitlement unchanged for a partial refund, receipt amended                     | Not run                                                                                                                                                                                                                                                                                                                                                                    | OPEN  |
| C-07 | Real remainder refund                         | Second refund books the rest, access revoked, old link refused                                      | Not run                                                                                                                                                                                                                                                                                                                                                                    | OPEN  |
| C-10 | Restore drill from a Cloud SQL backup         | Restore into a new instance, row counts and ledger totals match, app starts against it              | Not run (GCP Step K)                                                                                                                                                                                                                                                                                                                                                       | OPEN  |
| C-13 | Uptime check and budget alert                 | Alert email arrives when the sign-in page stops answering                                           | `monitoring.sh` not yet run                                                                                                                                                                                                                                                                                                                                                | OPEN  |

Also observed on the host: one real hosted purchase reached "Paid" (buyer sign-in, price, PayPal approval,
capture, read-back, library access); `/ops` healthy after the second deploy.

## The offline checks (fixture rows)

C-02 to C-05, C-08, C-09, C-11 and C-12 passed offline: see `docs/evidence/mvp-c-offline-gate-2026-10-25.md`
and the Postgres race runs of lane PG-2 (80 rounds, D-045).

## Findings from the hosted run (all logged)

1. A purchase failed with "Could not get a price" until `UMS_OWN_MERCHANT_ID` was set: it seeds the publisher
   payee that is verified at boot. It is now the eleventh secret of the kit.
2. Google reserves `/healthz` on run.app addresses; the uptime check uses `/signin`.
3. The simulator in the PayPal dashboard sends unsigned mock events: they do not teach the certificate
   (D-053). Only a real purchase does.
4. `gcloud run services logs read` shows blank lines for the app's JSON logs; use `gcloud logging read`.
5. The pin made 34 offline tests fail (they assumed an empty pin list). Fixed in the cert pin commit `c0da141`.

## Open items before closure

C-06, C-07, C-10, C-13 above; `UMS_OWN_MERCHANT_ID` secret set before the next deploy; owner deletes the
GitHub token used in Cloud Shell; the approval expires 2026-10-30 12:00 UTC; D-045 (ASM-55) must be re-waived
or the race tests re-run before the app stays live until 15 Dec.

## Closure

Not yet. When every row is PASS or an accepted offline row, add the finish steps (kill switch off, cost alert
checked, secrets rotated at the end of the credentialed phase) and the final commit id here.
