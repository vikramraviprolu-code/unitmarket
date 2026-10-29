# MVP-D owner steps (two publishers, one approval, two PayPal orders)

Nothing connects to PayPal until the written D-0xx row is merged and the owner has inserted the approval with `safety:approve` at their own terminal. D-052 expires on 2026-10-30 12:00 UTC and D-055 was dropped (D-056): there is no extension.

For two people on a call: **Vikram** (V) holds the credentials and the keyboard; **Sakthi** (S) oversees. Time:
about 90 minutes in one sitting. The assistant never sees your credentials, never runs these steps and never
holds a key. All rules of `docs/owner/SPIKE-RUNBOOK.md` ("What you never share or paste anywhere", machine
rules, refusal table) and of `docs/owner/MVPB-OWNER-STEPS.md` apply here too; this list reuses its local
setup. It follows the style of `docs/owner/MVPC-OWNER-STEPS.md`.

This sitting proves the real half of D-01: one buyer approval turns into two PayPal orders, each approved
and captured on its own, and both land in the owner's own sandbox Business account. Read
`docs/evidence/mvp-d-offline-gate-2026-10-29.md` first: it says what already passed offline. A pass offline
proves the modelled cases only, not PayPal compatibility.

**Not in this sitting** (D-042): a real decline (D-02 real is NOT attempted; do not try to provoke one at
PayPal, the offline twin uses a fixture), the hosted webhook (see below), the hosted app (D-052 expired on
30 Oct 12:00 UTC and was not extended, D-056), and a second merchant account (D-041: a stretch item).

## Who does what

| Person     | Does                                                                                                                                                                                              | Never does                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| V (Vikram) | Types every command. Holds `.env.local`, the PayPal logins and the TOTP-free local terminal. Presses Stop at any doubt.                                                                           | Shares his screen while `.env.local`, a password, a client secret or a browser address bar with `token=` is visible. |
| S (Sakthi) | Watches the shared screen (terminal output, `/ops`, the app pages). Reads each expected line aloud and says "go" or "STOP". Keeps the stop list (Step 7). Writes the evidence list as V reads it. | Types on V's machine, asks for a credential, or sees a file with a secret. Any "STOP" from S ends the sitting.       |

Either person can call STOP. V presses "Stop PayPal now" on `/ops` first, then talks.

## Prerequisites (before the day, no PayPal contact)

1. D-041 (both publishers paid into your own sandbox Business account; the payee is left out of every
   create, D-028; `payee_shared` is an explicit, audited flag) and D-042 (the approval basis and the ASM-55
   waiver for this one sitting) are recorded in `docs/decision-log.md`. They are. D-042 authorises nothing by
   itself: the row of the next item does.
2. **The sitting is local, on V's laptop, with the webhook OFF.** The coordinator decided this so that ASM-66
   does not arise. The approval row leaves out `verify_webhook_postback` and `fetch_webhook_cert`, and no
   `PAYPAL_WEBHOOK_ID` is set. A hosted webhook run added later needs its own ASM-66 waiver.
3. DP-5, DP-5b and this lane (DP-6) are merged to `main` and S gives V a reviewed tag. V pulls it. No hosted
   deploy is needed or wanted (a deploy switches the PayPal connection off, D-054).
4. **V writes the decision-log row** for the approval, in his own words, and S merges it. The row states, as D-042
   lists them:
   - its id (the next free `D-0xx`; it is the approval reference below, written `D-0xx`) and the scope `mvp_c_refunds`
     (no change to the transport scopes, ASM-70);
   - the operations, listed one by one: `oauth_token`, `create_order`, `get_order`, `capture_order`,
     `get_capture`. **Leave out** `verify_webhook_postback` and `fetch_webhook_cert`. **Leave out**
     `refund_capture` and `get_refund` unless a real composite refund is in this sitting (it is not planned:
     add both only if V and S decide so before the day, and say so in the row);
   - the cap **per PayPal order**: 2000 minor units (20 USD), with the plain sentence "the pack total is not
     enforced by the gate and is bounded only by twice the cap";
   - calls per day: **60**. One happy pack uses 12 PayPal calls (1 token, 2 creates, 7 reads, 2 captures). The
     60 covers two packs (24), the continuation reads of a pack that stops between its captures (about 3 to 5 more calls, up to 12 with margin),
     and the job loop's polling, which may use at most half of the day's budget (ASM-52). Do not raise it;
   - `valid_until`: **at least 3 hours after the planned end of the sitting** (so a pack stopped between its two
     captures can still be finished within the same approval), never more than 7 days. The sitting itself
     **must never cross 00:00 UTC**: the daily call budget resets there and the 60 calls would no longer mean
     what this list says. Plan the start so the whole sitting, with a margin, ends before midnight UTC;
   - the operator `vikram`;
   - the payee mapping: both publishers into the owner's sandbox Business account (last 4 only: `…XXXX`), the
     payee left out per D-028; **any create body naming a payee is a stop**;
   - the buyer: the sandbox **Personal** account only;
   - that a real D-02 decline is not attempted (fixture only);
   - that it supersedes the MVP-C row for the window (D-052 expires on 30 Oct 12:00 UTC, D-056);
   - references: D-028, D-029, D-035, D-037, D-041, D-042, D-056.
     The row holds no credential, no full merchant id and no order id.
5. Your sandbox Business account's receiving preference for USD is not "ask me" or "block" (as in MVP-B).
6. **No overlap with the hosted MVP-C app (D-054).** Hold the sitting after D-052 expires (2026-10-30 12:00 UTC)
   or only when Sakthi has confirmed that nobody is testing on the hosted app. Both use the same sandbox Business
   account, so a payment made by someone else would be mistaken for this pack's. In Steps 4 and 5, match the
   PayPal activity rows to this pack by **time and amount** (the two amounts of the pack, within the minutes of
   the sitting), never by "two rows appeared".
7. The **pack window** is 60 minutes from the first approval (`pack_approval_window_ms`). You will finish in
   under 15. If the window runs out with only one approval, nothing is charged and the pack is abandoned.

## Step 0: machine check (5 min, V types, S watches)

```
eval "$(fnm env)" && fnm use 22.22.0
node -v                                  # v22.22.0
corepack pnpm -v                         # 10.34.7
cd path/to/unitmarket-sandbox
git fetch --tags && git status --short   # prints nothing
git checkout <the reviewed tag>
corepack pnpm install --frozen-lockfile
corepack pnpm run ci                      # ends without an error (takes several minutes)
```

Off any VPN. A normal terminal window. No proxy variables. Run the first line in every NEW terminal window.
S checks: `v22.22.0`, `10.34.7`, `git status --short` empty, `ci` ended without an error.

## Step 1: settings file (10 min, V alone on screen; S looks away or is not shown the editor)

Use a **fresh data folder**: `mkdir -p ~/unitmarket-sbx-data-d`. On its first start the app gives both
publishers your own merchant id and flags both `payee_shared` (the DP-5 boot step). If you reuse the MVP-B
folder instead, the same step flags Harbour and adds Quayside; if the app logs `seed.payee_refused` at start,
that folder holds another id: STOP and use a fresh folder.

Create `.env.local` in the repository folder (ignored by git). Run `corepack pnpm owner:secrets` for the four
app secrets as in MVP-B Step 1 (the hash line starts with `scrypt:`). Then these lines, with your values:

```
UMS_MODE=sandbox
UMS_PAYPAL_CONNECT=on
UMS_OUTBOUND_APPROVAL_REF=D-0xx
UMS_OUTBOUND_SCOPE=mvp_c_refunds
UMS_OWN_MERCHANT_ID=<merchant id of your sandbox Business account, 13 characters A-Z and 0-9>
UMS_DB=pglite-disk
UMS_PGLITE_DIR=/Users/<you>/unitmarket-sbx-data-d
UMS_PUBLIC_ORIGIN=http://localhost:3000
NEXT_PUBLIC_UMS_ENV_LABEL=Sandbox
NEXT_TELEMETRY_DISABLED=1
PAYPAL_CLIENT_ID=<paste from the Sandbox tab of Apps & Credentials>
PAYPAL_CLIENT_SECRET=<the ROTATED secret, pasted after clicking Show>
```

Do **not** set `PAYPAL_WEBHOOK_ID`, `UMS_WEBHOOK_CERT_LEARN_UNTIL` or `UMS_OPERATOR_TOTP_KEYS` (no webhook, no
refund in this sitting). `UMS_OWN_MERCHANT_ID` is the same value as in MVP-B; it is never committed and never
pasted anywhere except its last 4 characters. Save, close the editor, never print the file, clear the
clipboard. Copy it for the build: `cp .env.local apps/web/.env.local` (deleted in Step 6).

## Step 2: the approval row and the switch (app NOT running, 5 min)

V types, at his own terminal (`safety:approve` and `safety:resume` refuse without a real terminal, in CI and
in an AI session; do not pipe or script them):

```
corepack pnpm safety:approve --operator vikram --ref D-0xx --scope mvp_c_refunds \
  --ops oauth_token,create_order,get_order,capture_order,get_capture \
  --max-amount 2000 --max-calls 60 --valid-until <YYYY-MM-DDTHH:MM:00Z, at least 3 hours after the planned end> --approved-by vikram
```

Expected: one line `Approving oauth_token, create_order, get_order, capture_order, get_capture up to 2000 minor
units, 60 calls a day, until <date>.`, then `Type the scope name (mvp_c_refunds) to confirm:`. V types
`mvp_c_refunds`. Expected: `approval D-0xx recorded`. S checks that the operations line has exactly the five
names (no `verify_webhook_postback`, no `fetch_webhook_cert`, and no refund operation unless the row says so)
and that the numbers are 2000 and 60. If the line differs: STOP, nothing was written beyond the row; tell the
coordinator.

Then:

```
corepack pnpm safety:resume --operator vikram --reason "MVP-D session"
```

Expected: `Turning paypal_outbound on for approval D-0xx: scope mvp_c_refunds, 60 calls a day, up to 2000 minor
units per order.`, then `Type the scope name (mvp_c_refunds) to confirm:`. V types `mvp_c_refunds`. S checks the
scope, the 60 and the 2000 before V presses Enter. Then:

```
corepack pnpm safety:status
```

Expected: `switch paypal_outbound=on` and, on one line (the operations are joined by commas with no space, so
a literal comparison works):

```
budget D-0xx: 60 of 60 calls left today; per-order cap 2000 minor; valid until <date>; operations oauth_token,create_order,get_order,capture_order,get_capture
```

Screenshot the status output (it holds no secret). Note the number of calls left: **60**.

## Step 3: build and start the app (5 min)

```
corepack pnpm --filter @umsbx/web build
corepack pnpm --filter @umsbx/web start
```

Rebuild after every `git pull`. Always use `http://localhost:3000`, in Chrome (Incognito is fine). Leave the
window open; it is the app log. Do not share this window while it scrolls anything you did not expect.

V signs in as `operator` at `http://localhost:3000/ops`. S checks on the shared screen:

- the gate block shows all **five locks open** and the transport `sandbox (approved)`;
- `paypal_outbound` is On, and "Calls left today" reads `60 of 60`;
- a shared-payee line: **2 publishers share the payee ending in your last 4** (the D-041 flag, from stored data);
- the environment label reads Sandbox (it comes from the stored environment, never from a guess).

Any lock missing, or a count other than 2 publishers: Ctrl-C and STOP.

## Step 4: the pack, through both approvals (D-01 real half, 20 min)

V opens a Chrome Incognito window at `http://localhost:3000`, signs in as `buyer-a`. The pack is **one
Harbour item and one Quayside item**, each a single option; both are far below the 20 USD cap.

1. `/discover`: select one Harbour item and one Quayside item, then ask for approval.
   S checks the approval page: **two blocks**, one per publisher, each with its item and subtotal; the line
   "2 payments"; the total equals the two subtotals; the terms box. V ticks the terms and presses Approve.
   _Nothing has been captured yet._ (There is no PayPal page yet.)
2. V is sent to the first PayPal sandbox page. **Check the address bar starts with
   `https://www.sandbox.paypal.com`** (read only the start aloud; never show the `token=` part). V logs in as
   the sandbox **Personal** account and approves payment 1.
3. V returns to the app. S checks that the page says **"Step 2 of 2"**, names the second publisher, and shows
   one button to the next approval; there is no automatic redirect. In the Business account's activity (V's
   other tab, crop to date, amount and status) **no payment exists yet for this pack's amounts and times**:
   nothing was captured after the first approval. Match by time and amount; a row from someone else is not this
   pack's. If a payment already shows: STOP (Step 7, item 1).
4. V presses the button, logs in again if asked, approves payment 2 at PayPal, and returns.
5. The order page shows **both items "Ready in your library"** (one line per item), and the library holds two
   entries. The receipt (one version) names both publishers. S reads the status: `Paid`.

Screenshot (V, cropped, no address bar with `token=`): the approval page with two blocks; the "Step 2 of 2"
page; the order page with two ready items; the library with two entries; the receipt. The pages show only the
last 6 characters of ids.

If V closes the browser between the approvals, V reopens the order from the library and uses the
stored link on the "Step 2 of 2" page. If more than 60 minutes passed since the first approval, the whole pack
is cancelled and nothing is charged: say so and stop. A second pack is allowed **only** if the first ended with zero captures (abandoned or never
approved) **and** at least 24 calls are left on `safety:status`; otherwise end the sitting.

## Step 5: read the books (10 min)

1. **PayPal Business account** (V's other tab, sandbox dashboard, activity): crop to date, amount, status.
   Expected: **two** payments matching this pack's two amounts and the minutes of Step 4, one for each item, both into this one account, both Completed. A single payment
   for the sum, or one that contains two items: STOP (Step 7, item 2).
2. `/ops` (operator): the order row `paid`; the shared-payee line unchanged.
3. Stop the app (Ctrl-C in its window), then V runs `corepack pnpm safety:status` and S reads the budget line.
   Expected: **48 of 60** calls left (12 used by a happy pack). **44 to 47 left is accepted when a reason is
   noted**: reloading the return page or restarting the app adds calls, because the return page reads the order
   again on every render (`apps/web/src/app/checkout/return/page.tsx` calls the return handler each time).
   **STOP** only when one pack used more than about 16 calls or the drop cannot be explained. The status command
   needs the app stopped (the database lock).

## Step 6: finish (5 min, V types)

```
corepack pnpm safety:stop --operator vikram --reason "end of MVP-D session"
corepack pnpm safety:status            # switch paypal_outbound=off
```

Close the terminal. Delete `apps/web/.env.local` (the copy of Step 1). Clear the clipboard. Leave `.env.local`
or delete it; never copy it elsewhere. The approval row stays in the database and expires at `valid_until`.

## Step 7: stop conditions (S reads them aloud before Step 4; any one ends the sitting)

STOP means: V presses "Stop PayPal now" on `/ops` (or Ctrl-C), nobody retries, nobody edits a setting to make it
pass, V writes down what was on screen, and S tells the coordinator. Nothing in this list needs a credential.

1. **Any capture before both approvals.** A payment appears in the Business account's activity while the second
   approval at PayPal is still open, or the order page says `Paid` after one approval.
2. **Any create with two units.** One PayPal approval page that lists both items, or one payment for the sum of
   both items. The design is one PayPal order per publisher.
3. **Any create body naming a payee, or any payee in a read-back other than the stored one.** The app refuses
   the first at the gate and holds the order on the second: the order page says an item is **"On hold while we
   check it"**, `/ops` lists the order as held, or the app log names a payee mismatch. Do not "release" it.
4. **Any `DUPLICATE_INVOICE_ID`.** Checkout fails before the first PayPal page, or the app log names it. Your
   account has duplicate blocking on (D-033); a retry reuses nothing and will not help.
5. **Anything else unexpected:** an address bar that does not start with `https://www.sandbox.paypal.com`; a
   charge in an amount you did not expect; the budget falling faster than 12 per pack; a lock shown missing;
   the pack window running out; a payment declined on its own (do not try again, bring the screen).

**STOP after a capture.** If a STOP happens when at least one capture has been sent (one payment exists in the
Business account, or the order page says `Confirming payment` or shows one item ready and one waiting): keep the
data folder as it is (do not delete or recreate it), write down what the screen shows (order status, which item
is ready, the PayPal activity rows with time and amount), and do not retry, re-approve or start another pack. The
coordinator decides whether V runs `safety:resume` (within `valid_until`) so the continuation can finish the pack;
that takes about 3 to 5 more calls. Never resume on your own.

D-02 real is not attempted. If a decline happens by itself, that is a finding to bring back, not a retry.

## What to bring back to Sakthi

No secret, no full id, no merchant id, no token. S writes these into the evidence form as V reads them.

1. **Two order ids and two capture ids, the last 6 characters each**, one pair per publisher. The order page
   and the receipt show shortened ids; the PayPal transaction detail shows the capture (transaction) id. If the
   app shows none of them, write "not shown" and say where you looked.
2. **Debug ids.** The app stores one per PayPal call in its call records, but no owner command lists them yet
   (open finding F-1 of the gate report). Bring any `PayPal-Debug-Id` you can see in the developer dashboard,
   otherwise write "debug ids: not available to the owner".
3. The `safety:status` output before (60 of 60) and after (Step 5).
4. **The `provider_calls` count: 12 for a happy pack** (the drop in "calls left" is the count). More (up to 16) only with a
   reason written next to it: the continuation ran (a pack stopped between its two captures and was finished),
   a return page was reloaded, or the app restarted.
5. The sentence, copied exactly (D-041): **"Two publishers settled as two PayPal orders into one test merchant
   account; multi-merchant payout not demonstrated."**
6. The screenshots listed in Steps 2 to 5.
7. One line per step: done, skipped, or what you saw instead. Anything that surprised you.

Not covered today: the webhook (off), a real refund (not in the row), a real decline (D-042), a hosted run,
and a second merchant. Sakthi turns what V brings into `docs/evidence/` in a reviewed pull request and marks
D-01 real PASS, FAIL or PARTIAL on that evidence alone.
