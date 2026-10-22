# Sandbox baseline (planning input, not evidence of a fresh check)

Source: Vikram's PayPal developer dashboard screenshots of 21 October 2026, relayed in chat on 22 October. Nothing here was re-checked by us. No credentials are included, and none may ever be added to this file.

This baseline is not approval to connect to PayPal and not approval to run the spike (D-011, D-023).

## What the baseline says

| Item                | Baseline                                              |
| ------------------- | ----------------------------------------------------- |
| REST app            | "Default Application" present, in Sandbox mode        |
| Sandbox accounts    | Two: Business (Germany) and Personal (Germany)        |
| App to account link | The Business account is linked to Default Application |
| Webhooks on the app | List empty                                            |

## Planning consequences

- MVP-B is planned on the German pair, USD first (D-023). Webhooks are out of MVP-B (polling only) and arrive with hosting in MVP-C.
- With no webhook registered, nothing can call us back. This matches the polling-only MVP-B design.
- Two accounts only, so MVP-D route D1 (second payee) cannot be tested without a second Business account. The default route D2 (one PayPal order per publisher) does not need one.

## Evidence we do not have yet (to be collected by the owner or Sakthi, by hand)

These are the gaps. None is needed to keep building offline.

1. Business account: currencies held and the payment receiving preference for USD (accept, convert or block). This decides whether a USD capture completes or sits pending.
2. Business account: confirmed country, account type and payee merchant id (last four characters are enough for the record).
3. Personal account: whether it has a funding source and balance in a currency that can pay USD.
4. REST app: enabled features and the scopes returned by the token call (note whether payouts appears; Payouts stays off).
5. Real behaviour of create, approve, capture, read-back, refund and replay with the same request key (spike Part W, a separate written approval).
6. Webhook certificate host and path (after hosting, MVP-C).

Items 1 to 4 are spike Part R, read-only, run by hand with `docs/owner/SPIKE-RUNBOOK.md` once the review fixes have merged and the owner decides to run it.
