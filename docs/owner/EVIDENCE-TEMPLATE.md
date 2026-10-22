# Spike evidence form (Part R)

Copy this file, fill in the copy, give it to Sakthi. Do not paste secrets here. If a box asks for something you cannot find, write "not found". Do not guess.

Never write in this form: client id, client secret, access token, sandbox account emails or passwords, full order or capture ids.

## Run details

| Field                                                   | Your entry |
| ------------------------------------------------------- | ---------- |
| Name (vikram or sakthi)                                 |            |
| Date and local time                                     |            |
| Approval reference used (for example D-024)             |            |
| Mode (read or write)                                    |            |
| Was this a real run, not `--dry-run`? (yes/no)          |            |
| Output folder name (the date)                           |            |
| `Calls used` line from the end of the run               |            |
| Anything that surprised you on screen (quote the words) |            |

## Step 1: the REST app (from the dashboard)

| Field                                                | Your entry |
| ---------------------------------------------------- | ---------- |
| App name                                             |            |
| Sandbox tab was selected? (yes/no)                   |            |
| Features that are ticked (list them)                 |            |
| Is Payouts ticked? (yes/no). Did you leave it alone? |            |

## Step 2: the sandbox accounts

| Field                                                                                                          | Business account | Personal account |
| -------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| Country                                                                                                        |                  |                  |
| Account type                                                                                                   |                  |                  |
| Currencies held and balances (for example EUR 5000.00)                                                         |                  |                  |
| Is USD in the list? (yes/no)                                                                                   |                  |                  |
| Payment receiving preference for a currency it does not hold (accept and convert / ask me / block / not found) | n/a              |                  |

Merchant ids: if you write one, write only the last 4 characters.

## Step 3: token (from `summary.md`)

| Field                                        | Your entry |
| -------------------------------------------- | ---------- |
| HTTP status                                  |            |
| `token_type`                                 |            |
| `expires_in` (seconds)                       |            |
| Scope list (paste the list from the summary) |            |
| `payouts_in_scope` (true/false)              |            |

## Step 4: not-found read (from `summary.md`)

| Field                                                    | Your entry |
| -------------------------------------------------------- | ---------- |
| HTTP status (expected 404)                               |            |
| `error_name`                                             |            |
| `issues`                                                 |            |
| `debug_id` (PayPal's id for this answer; safe to share)  |            |
| `debug_header_names` (the exact header name PayPal used) |            |

## Step 5: webhooks

| Field                                                                        | Your entry |
| ---------------------------------------------------------------------------- | ---------- |
| Does the developer site show any webhook for the app? (none / some / unsure) |            |

## Questions the spike answers (Sakthi fills these in with you)

| Question                                                                            | Answer from the evidence above | Decision needed from Vikram |
| ----------------------------------------------------------------------------------- | ------------------------------ | --------------------------- |
| Does the Business account hold USD, or will USD be converted or blocked?            |                                |                             |
| Does the token scope list include payouts? (it should not matter, we never call it) |                                |                             |
| Does PayPal answer the not-found read as the docs example shows?                    |                                |                             |
| Is any webhook registered?                                                          |                                |                             |
| Is a US account pair needed? (only if USD cannot complete)                          |                                |                             |

## Files to hand over (optional)

Tick the cleaned files you read through and found free of emails, names and long random strings.

- [ ] `summary.md`
- [ ] `03-token.json`
- [ ] `04-not-found.json`
- [ ] `05-webhooks.json`

## Sign-off

| Field                                                                | Your entry |
| -------------------------------------------------------------------- | ---------- |
| I did not paste the client id, secret or any token anywhere (yes/no) |            |
| I closed the terminal window that held the variables (yes/no)        |            |
| Reviewed by Sakthi (date)                                            |            |

## Part W entries (only after a separate written go)

Only if Part W was run. Use the last 6 characters of order, capture and refund ids and the last 4 of merchant ids.

| Step                                                      | HTTP status | Result in one line (from `summary.md`) | Matches the expected outcome? |
| --------------------------------------------------------- | ----------- | -------------------------------------- | ----------------------------- |
| 6 create order                                            |             |                                        |                               |
| 7 repeat with same key                                    |             |                                        |                               |
| 8 GET before approval                                     |             |                                        |                               |
| 9 capture before approval (expect 422 ORDER_NOT_APPROVED) |             |                                        |                               |
| 10 GET after approval (expect APPROVED)                   |             |                                        |                               |
| 11 capture, repeat, new key                               |             |                                        |                               |
| 12 read-back                                              |             |                                        |                               |
| 13 EUR comparison (only if PENDING)                       |             |                                        |                               |
| 14 refunds                                                |             |                                        |                               |
| 15 two-unit order                                         |             |                                        |                               |
| 16 second payee (only with a second Business account)     |             |                                        |                               |
| 17 late captures                                          |             |                                        |                               |
