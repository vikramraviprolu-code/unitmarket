# MVP-B payee echo check (D-028), 2026-10-24

Run by the owner (Vikram) on his own laptop, Node 22.22.0, under approval D-035 (scope `mvp_b_polling`), with `pnpm sandbox:conformance --only payee-echo`. Sanitised result printed by the run's own `summary.md`. No credential, token, merchant id or email is recorded here.

| Item                                  | Result                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Wire self-check before the first call | `env_override false`, `builtins_intact true`                                                                                          |
| Case                                  | B-01 create, then D-028 payee echo                                                                                                    |
| Result                                | PASS, HTTP 200                                                                                                                        |
| What was checked                      | The order was created with the payee left out (option c, D-028). The read-back showed PayPal echoing our own merchant id as the payee |
| Printed line                          | `payee echo: own id`                                                                                                                  |
| Debug id                              | ca4f928f75d59                                                                                                                         |
| Order id (last 6)                     | 552451                                                                                                                                |
| Calls used                            | 3 (token, create, read) of the 300 a day in D-035                                                                                     |
| Stopped                               | no                                                                                                                                    |

## What this proves

PayPal treats an order created without a payee as belonging to the account of the app, and the sealed transport, the five locks, the production wire (Node 22.22.0 bundled roots) and the D-028 check work end to end against the real sandbox.

## What it does not prove

No capture, no buyer approval, no refund, no USD capture into the EUR-only Business account. Those are the next steps (4 to 6 of the owner steps).

## Note on the run folder

`calls.json` in the run folder keeps the merchant id in full and the approval-link token. It stays on the owner's Mac. The redactor fix is lane BU-6b.
