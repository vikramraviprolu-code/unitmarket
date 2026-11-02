# Spec: the kill switch says so when the connection flag is off (WEB-POLISH-2)

Task: copy only. With the switch On and the Cloud Run connection flag Off, the card must not say "calls allowed".
Package: `apps/web` (copy, three components, tests) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/web-polish-r3` Commit: `feat(web): kill switch copy when the flag is off (WEB-POLISH-2)`

Goal: Start PayPal turns the switch On and never touches the flag (D-070). Today the badge reads "On: PayPal calls allowed" and the sentence under it "PayPal calls are on (in force within 5 seconds)", while a line far below says no call goes out. After this task, when the switch is On and the flag is Off, the badge and the sentence say plainly that the switch is on, the flag is off and no PayPal call goes out. Switch On with the flag On, and switch Off, keep today's words. No logic changes: the flag state is the value the page already passes (`snap.gate.mode === 'sandbox' && !snap.gate.connect`, or the start answer's `connect_flag`).

Also the Stop result said "use Start PayPal with your authenticator code". Checked: `/api/ops/start` takes a reason and the typed scope only; there is no code field. The code is carried by the sign-in (an operator session without it gets 403 mfa_required). So the Stop text becomes "use Start PayPal while signed in with your authenticator code, or the owner runs pnpm safety:resume at their terminal."

Inputs: `src/lib/ops-copy.ts`, `src/lib/ops-home-copy.ts`, `src/app/ops/{page,KillControls,StopButton}.tsx`.
Outputs: those files; `src/golden/ops-home-copy.golden.txt` (one new line); the tests below.

Acceptance tests (run from the repo root):

- `corepack pnpm exec vitest run --project unit apps/web/src/ops-copy.test.ts apps/web/src/ops-home-copy.test.ts`: badge and sentence for the three states; Stop words.
- `corepack pnpm test:integration`: the page source passes the flag to both badges and to the start sentence.
- `corepack pnpm test:golden`: the golden has the new "flag off" line; all other lines unchanged.
- `src/ui/contrast.test.ts` unedited and green: the badge keeps the existing `warn` Chip tone, no new colour.

Do not: change logic, routes, the flag, approval code, safety, transport; add a colour or dependency.
Evidence for the PR: red then green output; list of edited tests (none of the old pins needed an edit: the default argument keeps today's words).
