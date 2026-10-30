# Spec: submission text, testing instructions and deploy preparation drafts (DOCS-B)

Task: three drafts for the owners (second half of the requested `docs-close-out`): the Devpost submission text, the judges'
testing instructions, and the exact human commands for Sakthi to build and deploy with the PayPal connection left off.
Package: `docs/` only Owner: builder (Sonnet) Reviewer: Opus, one round; owners approve every word (H, items 68, 69)
Branch: `docs/close-out-b` Commit: `docs(<area>): <what> (DOCS-B)` Decisions: D-065 (rules), items 12, 17, 20 to 24, 36, 64,
66 to 69; D-049, D-056, D-062, D-066. Runs LAST (after the other overnight lanes merge), so it describes what is on `main`.
Common rules: plan section 2.

Goal: drafts the owners can edit, not final text; every claim traceable to a file, a test or an evidence document; what is
real, what is a fixture and what is simulated said plainly (D-041 wording, the judge line of the publisher proposal section 4).

1. `docs/submission/submission-text.md`: sections as the Devpost form asks (inspiration, what it does, how we built it,
   challenges, accomplishments, what we learned, what's next, built with). Agentic commerce framing of item 17: the agent
   finds and composes within limits; a human approves every payment; say which parts are AI (the Claude adapter when
   switched on, decision 13) and which are code (the scripted model, the money path). Settlement wording from stored data
   and the actual state of item 28 on `main` (if Quayside's own account has not been proven, say "both publishers are paid
   into one sandbox test account; multi-merchant payout not demonstrated"). Commission: "No commission in this demo; planned
   20 percent, not implemented." No third-party trademark beyond naming PayPal and Claude as the tools used.
2. `docs/submission/testing-instructions.md`: two paths (item 20): offline from the repo (the README's ten-minute run,
   commands copied from `README.md` and `package.json`, nothing invented) and the hosted URL. Credentials only as
   placeholders: `<demo passcode: in the Devpost form only>`, `<sandbox buyer login: in the Devpost form only>` (items 22, 24).
   Say when hosted payments are live (item 21: three seven-day rows from 30 Nov) and that outside those windows the app runs
   the labelled Dry run path (item 23). What a judge sees for each persona (buyer, publisher, operator), and how to tell
   Sandbox from Dry run (the label from stored data).
3. `docs/owner/DEPLOY-PREP-2026-11.md`: numbered commands for Sakthi, based on `infra/gcp/deploy.sh` and
   `docs/owner/MVPC-OWNER-STEPS-GCP.md` Steps A, D, F, G and K (read both in full first). In order: confirm `main` is the
   reviewed commit and `corepack pnpm run ci` is green on it (locally); take a database backup (Step K pattern) before a
   deploy that applies migration 0012; the owner creates and pushes the reviewed tag (human; no tag is created overnight);
   `bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" TAG` in Cloud Shell; check `UMS_PAYPAL_CONNECT: 'off'` in
   `infra/gcp/service.yaml` before and the switch state after (`safety:status` through the Auth Proxy with the `env -u`
   prefix); the first sign-in check. State what is NOT on the hosted app until a reviewed infra change adds the secrets:
   publisher personas (`UMS_PUBLISHER_PASSCODE_HASH`), the Claude adapter (`UMS_AI_ADAPTER`, `UMS_ANTHROPIC_API_KEY`); see
   the plan section 6. Never schedule a deploy during an owner sitting (it turns the connection off).

Acceptance: `corepack pnpm exec prettier --check docs/submission docs/owner/DEPLOY-PREP-2026-11.md` passes;
`corepack pnpm check:no-live-host` and `corepack pnpm check:secrets-names` pass; `grep -rnE '[A-Z0-9]{13}' docs/submission
docs/owner/DEPLOY-PREP-2026-11.md` shows no merchant id; every command in the deploy file appears verbatim in `deploy.sh`,
the owner steps or `package.json` (list each with its source in the hand-back).
Do not: run any command against Google Cloud, PayPal or a hosted URL; write a credential, project id, project number or
merchant id; promise a feature that is not on `main`; change any other file.
Evidence: the three paths, the check output, the command source list, the open questions for the owners, cost line.
