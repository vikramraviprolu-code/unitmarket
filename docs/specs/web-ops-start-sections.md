# Spec: Start button on Operations, and section tabs on the operator pages (WEB-OPS-START)

Task: Operations gets a "Start PayPal" control beside "Stop PayPal now" (ENH-2), and every long operator page gets the SectionNav tab bar.
Package: `apps/web` (ops pages, `api/ops/start`), `packages/safety` (shared resume check), composition Owner: builder (Sonnet) Reviewer: Opus (money path, security)
Branch: `feat/web-ops-start-sections` Commit: `feat(web): <what> (WEB-OPS-START)` Decisions: D-062, D-069, ENH-2; owner reply 31 Oct: build it, keep the Cloud Run flag as a separate lock.

Goal: an operator who signed in WITH the authenticator code can switch `paypal_outbound` back on from Operations, only while an active approval row covers it. The button cannot insert an approval and cannot set `UMS_PAYPAL_CONNECT` (that stays a Cloud Run setting the owners change). Until the flag is on, no PayPal call leaves, and the panel says so in words.

Behaviour:

- `POST /api/ops/start`: `auth: 'operator'`, `csrf: true`, NOT `fail_safe_without_mfa`: the session must carry `mfa: true` (code typed at sign in), else 403 with a plain message. Body `.strict()`: `reason` (3 to 200 chars after trim) and `confirm_scope` (must equal the scope of the active approval row, typed by the operator). Rate `ops_start` 5 per hour per actor. Audit row `safety.resume` with actor, reason, approval ref, scope (same shape the CLI writes).
- The checks are the SAME code as `pnpm safety:resume` (`packages/safety/src/cli-resume.ts`): extract the shared check into one function both call, keep every CLI refusal (`no_active_approval`, expired, calls budget used up, scope mismatch, kill switch locked by another reason). Refuse with 409 and a plain sentence for each; never a stack.
- Answer on success: `{ outbound_on: true, connect_flag: 'on' | 'off', calls_left, valid_until }`. The page then shows the Switch as On and a line: "The connection flag is off. No PayPal call goes out until the owners turn it on in Cloud Run." when `connect_flag` is off.
- `/ops` Kill switch block: when the switch is Off show the Start form (reason, scope field with the active scope as a hint, button "Start PayPal"); when On show the Stop form as today. Both forms always render; the one that does not apply is replaced by one sentence saying why. No operator with the code: the Start form is replaced by "Sign in with your authenticator code to start PayPal." Words in `lib/ops-copy` (or the file already holding the ops words), keyboard reachable, error text in an `ErrorState`.
- Tabs: add `SectionNav` (`apps/web/src/ui/SectionNav.tsx`, already in main) with matching section ids to `/ops`, `/ops/publishers`, `/ops/payee-requests`, `/ops/evals` and any other `/ops/*` page longer than two screens. Do not edit `SectionNav.tsx` or `section-nav.css` (another lane owns the look).
- `apps/web/src/app/api/ops/stop/route.ts` comment that says "it cannot turn anything on" is updated; Stop is unchanged.

Acceptance tests (each prints green; red first, commit 1 holds only tests):

- `corepack pnpm test:state apps/web packages/safety` (start refused: no session, buyer, publisher, operator without code, no approval, expired approval, budget used up, wrong scope text, wrong reason length, switch locked by another reason; start succeeds with code, writes one audit row, calls left unchanged)
- `corepack pnpm test:adversarial apps/web` (CSRF missing or wrong origin, replay, unknown fields, 6th call in an hour answers 429, a stolen plain-session cookie cannot start, stop still works without the code)
- `corepack pnpm test:integration` for the ops page markup (both forms, tabs, ids match)
- `corepack pnpm check:routes` (new route in the route table and the maintenance walk), lint, typecheck, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`

Do not: change `endpoints.ts`, transport, the five locks, the approval insert or `safety:approve`; read or set `UMS_PAYPAL_CONNECT` anywhere new except to display it; add a dependency or migration; touch publisher or buyer pages, `globals.css` or skins.
Evidence: red run, green outputs, a screenshot of /ops in both skins with Start visible (switch Off) and with Stop visible (switch On).
