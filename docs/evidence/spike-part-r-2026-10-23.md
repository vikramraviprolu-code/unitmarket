# Spike Part R, read-only run, 2026-10-23

Run by the owner (Vikram) on his own laptop, mode `read`, approval row D-032. Sandbox only. Guided one command at a time by the coordinating assistant, which saw only this sanitised summary. No credential, token, email or account id is recorded here.

| Item                              | Result                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calls used                        | 2 of 40 (one earlier attempt stopped at the token step with HTTP 401 because the secret was cut off when pasted; nothing was created)                    |
| Step 3, token request             | HTTP 200, `token_type` Bearer, `expires_in` 32400 seconds                                                                                                |
| Token scopes                      | invoicing, one-click with merchant-issued token, futurepayments, vault payment-tokens read, disputes read, and a payouts scope (`payouts_in_scope=true`) |
| Step 4, order that does not exist | HTTP 404, `error_name` RESOURCE_NOT_FOUND, `issues` INVALID_RESOURCE_ID, `debug_id` f936645ce8a60                                                        |
| Debug header name                 | `paypal-debug-id`                                                                                                                                        |
| Step 5, webhooks                  | operator note "unsure" (expected "none"; not needed before MVP-C)                                                                                        |
| Node on the laptop                | v26.0.0 (the project pins 22.22.0; the read-only run worked)                                                                                             |
| TLS                               | the handshake with the sandbox API host succeeded from the laptop with Node's bundled roots                                                              |

## Part 1 facts (dashboard, see D-033)

- Default Application, Payouts ticked, so the token carries a payouts scope. The app never calls Payouts (D-004). Unticking Payouts at PayPal would remove the scope; that is the owner's choice and has not been made.
- Both German sandbox accounts hold EUR only. The Business receiving preference was changed by the owner to accept without converting.

## What this does not prove

Only that the credentials work against the sandbox and that the 404 shape and debug header match what the code expects. No order, capture or refund has been made. A USD capture into a Business account that holds only EUR is still unverified until the first order.
