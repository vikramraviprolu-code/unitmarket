# Owner guide: the read-only PayPal sandbox check (Part R)

For: Vikram (or Sakthi). You do not need to be an engineer. Time: about 90 minutes the first time.

## What this is, in plain words

Before we connect UnitMarket to the PayPal sandbox, we want a few facts from the real sandbox: which currency works, what the accounts look like, and what PayPal says when you ask for something that does not exist. You collect them with two things:

- the PayPal developer website (clicking and reading), and
- a small program called the spike kit, which you run on your own computer.

Part R is **read-only**. It changes nothing at PayPal. It asks for a login token, then asks for one order that does not exist (PayPal answers "not found", which is what we want to see). Nothing is bought, created or charged.

Rules that always apply:

- Only you or Sakthi run the kit. The AI builders never run it against PayPal.
- Sandbox only. The kit refuses anything that looks like live or production.
- Your PayPal **client secret** and **client id** never go into a chat, an email, a document, a screenshot, a file in the repository or a pull request. Not even "just to check".
- If anything on screen surprises you, stop and ask Sakthi. Stopping is always safe.

## Before you start

1. You have the repository on your computer (the folder called `unitmarket-sandbox`).
2. Node 22 is installed. Open a terminal and type `node -v`. It should show `v22.` followed by numbers (the project uses 22.22.0). If it does not, ask Sakthi.
3. Sakthi has told you the **approval reference**: an id like `D-024`. It is a row in `docs/decision-log.md` that records your written go for the spike. The kit checks that the row exists. The row must carry the structured marker shown in "The approval row template" below. The kit refuses every row without that marker (for example `D-023`, which says it does not authorise any outbound call), a row for a different operator or scope, and a row past its `valid_until` date.
4. You know your PayPal developer login (the one that owns the sandbox accounts).
5. Run the kit only on your own machine, off any corporate VPN, and never inside a cloud, remote or AI container. Proxy and certificate settings in the environment change where your credentials go, so the kit refuses to start when any is present (see `transport_env_override` below).
6. Windows: Git Bash does not give the kit a real terminal (it refuses with `not_tty`). Use WSL (Ubuntu) as the only Windows route.

### The approval row template

Only the owner writes this row; no AI session adds it. Sakthi adds the row to `docs/decision-log.md` in a reviewed pull request after you have said yes in writing. Fill in the values and keep the marker text exactly:

```
| D-nnn | YYYY-MM-DD | SPIKE GO: scope=spike-read; operator=vikram; valid_until=YYYY-MM-DD; approved in writing YYYY-MM-DD | Owner | notes |
```

- `scope` is `spike-read` (Part R) or `spike-write` (Part W; also allows read).
- `operator` is `vikram` or `sakthi` and must match `SPIKE_OPERATOR`.
- `valid_until` is the last day the go is valid (the kit compares it with today's date).
- A row without the marker, with a bad date, or one that says it does not authorise outbound calls is refused.

## Part 1: dashboard checks (steps 1 and 2 of the runbook)

These are done in your web browser. The kit is not involved.

### 1. Find the sandbox REST app

1. Open a browser and go to `developer.paypal.com`.
2. Click **Log in to Dashboard** (top right) and sign in.
3. In the left menu click **Apps & Credentials**.
4. At the top of the page you will see two tabs or a switch: **Sandbox** and **Live**. Click **Sandbox**. Check that Sandbox is the one highlighted before you do anything else.
5. In the list of apps, find **Default Application** and click its name.
6. Write on the evidence form (`docs/owner/EVIDENCE-TEMPLATE.md`): the app name, and the word "Sandbox" if the page shows that it is a sandbox app.
7. Scroll down to **Features** (sometimes called "App feature options"). Write down, on the form, which features are ticked. **Do not tick or untick anything, and do not click Save.** In particular, leave **Payouts** unticked. If it is ticked, write that down and tell Sakthi; do not change it.

### 2. Find the credentials (and keep them private)

1. On the same app page, near the top, there is **Client ID** and **Secret**. The secret is hidden behind a **Show** link.
2. You do **not** copy these anywhere yet. Leave the page open in this tab. You will use them in Part 3, typing them into the terminal only.
3. Never take a screenshot of this page. Never paste the client id or secret into any document, chat or email.
4. If you think you pasted one somewhere by mistake: tell Sakthi straight away. A leaked secret is rotated within the hour.

### 3. Check the two sandbox accounts

1. In the left menu click **Testing Tools**, then **Sandbox Accounts** (on some screens: **Sandbox** then **Accounts**).
2. You should see the German pair we chose (decision D-023): one **Business** account and one **Personal** account.
3. For each account, click the three dots (**...**) at the end of its row and choose **View/edit account** (or click the account email). Write on the form, for each one:
   - **Country** (expected: Germany).
   - **Account type** (Business or Personal).
   - **Currencies held** and their balances (look at the **Funding** or **Balances** tab). We want to know if USD is in the list or only EUR.
4. Do not copy the email addresses or passwords of the sandbox accounts into the form. Write "Business" and "Personal" only.
5. Now check how the **Business** account receives money in a currency it does not hold (for example USD when it only holds EUR). This setting is inside the sandbox account, not on the developer site:
   1. In the account list, on the Business row, click **...** and choose **Log in to sandbox** (or use the login shown on the account page).
   2. In the sandbox PayPal page that opens, click the gear icon (**Settings**), then **Payments**, then **Payment preferences**.
   3. Find **Payment receiving preferences** (it may be called "Block payments" or "Receive payments in other currencies").
   4. Write on the form which option is selected for currencies the account does not hold. The wording is usually one of: accept and convert, ask me for each payment, or block.
   5. Do not change the setting. Click away without saving.
   6. Sign out of the sandbox page.
6. If a name on screen differs a little from the words above, that is normal: PayPal renames things. If you cannot find a setting after five minutes, write "not found" on the form and move on. Do not guess.

## Part 2: first, practice with the dry run

The dry run replays pretend answers stored in the repository. It has **no network access at all**. It needs no password and no variables. Use it to see what the real run will look like.

1. Open a terminal and go to the repository folder:
   `cd path/to/unitmarket-sandbox` (replace the path with where the folder is).
2. Type this and press Enter:
   `node tools/spike-kit/src/spike.ts --dry-run`
3. You may see a line starting "ExperimentalWarning". That is normal.
4. The kit prints each step: what it would send, with passwords shown as `[masked]`. It answers "y" by itself and marks it `[dry-run auto: y]`. It ends with "Finished." and a folder name.
5. Open that folder (it is printed as "Output") and look at `summary.md`. It says **DRY RUN** at the top. Nothing in it is PayPal evidence. Do not copy dry-run output into the evidence form.

If the dry run does not finish with "Finished.", stop and send Sakthi the last lines on screen. Those lines contain no secrets.

## Part 3: the real read-only run

### Set the variables, in this terminal window only

Variables are settings that live only in the open terminal window. When you close the window they are gone. Never put them in a file.

1. Open a **new** terminal window (not one you used for anything else).
2. Go to the repository folder as before.
3. Type these lines one at a time, pressing Enter after each. Replace `vikram` with `sakthi` if Sakthi is running it, and `D-024` with the reference Sakthi gave you:

   ```
   export SPIKE_OPERATOR=vikram
   export SPIKE_APPROVAL_REF=D-024
   export SPIKE_MODE=read
   ```

4. Now the two PayPal values. These commands do not show what you type, so nothing appears on screen. That is on purpose:

   ```
   read -s PAYPAL_CLIENT_ID; export PAYPAL_CLIENT_ID
   ```

   Press Enter. Now go to the browser tab with the app page, copy the **Client ID**, return to the terminal, paste, press Enter. Then:

   ```
   read -s PAYPAL_CLIENT_SECRET; export PAYPAL_CLIENT_SECRET
   ```

   Press Enter, copy the **Secret** (click Show first), paste into the terminal, press Enter.

   (On Windows, use the Windows Subsystem for Linux, or ask Sakthi to sit with you. Plain Windows PowerShell shows what you type.)

5. Check that the values are set, **without showing them**: type `env | grep -c '^PAYPAL_'` and press Enter. It should print `2`. Do not type `env` on its own and do not run `echo $PAYPAL_CLIENT_SECRET`.

### Run the kit

1. Type: `node tools/spike-kit/src/spike.ts` and press Enter.
2. If it says `REFUSED` followed by a word, read the table "If the kit refuses" below. A refusal is the kit protecting you. Nothing was sent.
3. For each step the kit shows the request it will send and asks `Send this request? [y/N]`. Read it. The web address must start with the sandbox host (`api-m.sandbox` ...). Type `y` and Enter to send, anything else to skip. Type `q` to stop the whole run.
4. The run is three steps:
   1. **Step 3, token.** One request to get a login token. The kit keeps the token in memory only and never prints or saves it.
   2. **Step 4, not-found read.** One request for an order named `AAAAAAAAAAAAAAAAA` that does not exist. PayPal should answer 404. That is the expected, good result.
   3. **Step 5, webhooks.** No request. The kit asks you whether the developer site shows any webhook for the app. To check: in the browser, on the app page, scroll to **Webhooks** (or **Sandbox webhooks**). Type `none`, `some` or `unsure`. We expect `none`.
5. At the end it prints `Calls used: 2 of 40` and the output folder. The folder is `~/unitmarket-spike/<today's date>/` (inside your home folder, outside the repository on purpose).
6. Close the terminal window when finished. That removes the variables.

### If the kit refuses

| It says                                                | Plain meaning                                                  | What to do                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REFUSED ci_set`                                       | The terminal thinks it is an automatic build machine           | Use your own normal terminal window                                                                                                                                    |
| `REFUSED not_tty`                                      | It is not a normal interactive window                          | Use a normal terminal window, not a script or an editor panel that cannot take typing                                                                                  |
| `REFUSED bad_operator`                                 | `SPIKE_OPERATOR` is missing or not vikram or sakthi            | Set it again                                                                                                                                                           |
| `REFUSED bad_mode`                                     | `SPIKE_MODE` is missing or not `read`                          | Set `SPIKE_MODE=read`                                                                                                                                                  |
| `REFUSED approval_ref_missing`, `approval_ref_pattern` | The approval reference is missing or malformed                 | Set `SPIKE_APPROVAL_REF` to an id like `D-024`                                                                                                                         |
| `REFUSED approval_ref_unknown`                         | No such row in the decision log                                | Ask Sakthi which row records your go                                                                                                                                   |
| `REFUSED approval_ref_not_authorising`                 | That row has no SPIKE GO marker or says it does not authorise  | Ask Sakthi for the row that records your written go                                                                                                                    |
| `REFUSED approval_scope_mismatch`                      | The row covers read only but you asked for write mode          | Ask for a row with scope `spike-write`, or use read mode                                                                                                               |
| `REFUSED approval_operator_mismatch`                   | The row names the other person                                 | Use the row written for you, or set `SPIKE_OPERATOR` correctly                                                                                                         |
| `REFUSED approval_expired`                             | The row's `valid_until` date has passed                        | Ask for a new written go                                                                                                                                               |
| `REFUSED transport_env_override`                       | A proxy, certificate or Node option variable is set            | Close the window, open a new one on your own machine off VPN, unset the variable named in the message. Never run inside a cloud or AI container                        |
| `REFUSED decision_log_unreadable`                      | The kit cannot read `docs/decision-log.md`                     | Use the kit from your checkout of the repository (the file `docs/decision-log.md` must be there)                                                                       |
| `REFUSED credentials_missing`                          | The client id or secret is not set in this window              | Redo the two `read -s` lines                                                                                                                                           |
| `REFUSED live_value` or `non_sandbox_host`             | Some variable mentions live, production or a different website | Close the window, open a new one, set only the variables above, and check you took the credentials from the **Sandbox** tab. If it happens again, stop and tell Sakthi |
| `REFUSED output_in_repo`                               | The output folder would be inside a repository                 | Do not use `--out`; let the kit use its default folder                                                                                                                 |
| `REFUSED bad_args`                                     | A word after the command was not recognised                    | Type the command exactly as shown                                                                                                                                      |
| `REDACTION SELF-TEST FAILED`                           | The kit's own safety test failed                               | Stop. Tell Sakthi. Do not run it again                                                                                                                                 |
| `Stopped: ... transport error`                         | The network request failed. The kit never retries              | Note the time. Tell Sakthi before trying again                                                                                                                         |
| `Stopped: token request failed with HTTP 401`          | PayPal rejected the credentials                                | Check you used the **Sandbox** app's id and secret, then redo Part 3. If it still fails, tell Sakthi                                                                   |

## Part 4: what to copy into the evidence form

Open `docs/owner/EVIDENCE-TEMPLATE.md` (make a copy to fill in; do not fill in the template itself).

1. Open the output folder and then `summary.md` in a text editor.
2. For Step 3, copy: the HTTP status, `expires_in`, `token_type`, the list of scopes, and whether `payouts_in_scope` is `true` or `false`.
3. For Step 4, copy: the HTTP status (expect 404), `error_name`, `issues`, `debug_id`, and `debug_header_names` (the exact name of the PayPal debug header, for example `paypal-debug-id`).
4. For Step 5, copy what you typed.
5. For steps 1 and 2, copy what you wrote down in Part 1.
6. The `.json` files in the folder (`03-token.json`, `04-not-found.json`, `05-webhooks.json`) are already cleaned by the kit. Before you share any of them, open it and read it once. If you see an email address, a person's name, or a very long string of random letters and digits, do not share it; tell Sakthi.
7. Keep the filled-in form and any `.json` files outside the repository (for example in your home folder or a private drive), never in the checkout. After you paste a secret into the terminal, clear the clipboard (copy any harmless word over it) and close the window.
8. Give the filled-in form (and optionally those three `.json` files) to Sakthi. Sakthi puts chosen outputs into the repository through a reviewed pull request, labelled as coming from your spike.

## What you never share or paste anywhere

- The client id or the client secret (treat the id as a secret too).
- Any access token (a long text starting with `A21` or similar).
- The passwords or email addresses of the sandbox Business and Personal accounts.
- Screenshots of the Apps & Credentials page, of the terminal while you were typing the variables, or of a browser address bar that contains `token=`.
- The output of the `env` command.
- The full order ids and capture ids from Part W (documents show only the last 6 characters; merchant ids only the last 4).
- Anything from a live (non-sandbox) PayPal account. If you see "Live" highlighted anywhere while following this guide, stop.

If any of these goes somewhere it should not, tell Sakthi at once. The rule is: rotate within the hour, and note it in the decision log.

## Part W (not part of today)

Part W creates sandbox test orders with play money and is still an outbound call. Do not run it from this guide. It needs a separate written go from you, a decision-log row that records it, and Sakthi beside you. When that exists, the only differences are `SPIKE_MODE=write` and a new approval reference. The kit then asks twice before every write. Step 17 needs the terminal left open for about seven hours; you can skip it. Step 18 happens after the app is hosted (MVP-C).
