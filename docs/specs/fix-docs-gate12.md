# Spec: copy and documentation fixes from the Opus end-to-end gate (FIX-DOCS)

Task: fix the wording and documentation defects the gate found on main (D2, D3, D6, D9, D12). No change to money paths.
Package: `apps/web`, `README.md` Owner: builder (Sonnet) Reviewer: Opus
Branch: `fix/gate12-copy` Commit: `fix(web): <what> (FIX-DOCS)` Decisions: D-028, D-041, D-051 (verb agrees with the number).

Goal: every sentence a reader sees is true of what the code does. The README Status table lists only merged work; the
README names the publisher passcode hash and how to make one; the publisher terms describe the real payee setup; a
publisher page counts and describes only what a buyer can buy; the order, error and item page words are plain.

Changes:

- D2, D3: `README.md` Status table (merged: AI adapter off by default and scripted unless `UMS_AI_ADAPTER=claude` with
  `UMS_ANTHROPIC_API_KEY`; publisher shell and payee change requests; two skins and the Appearance control; four draft legal
  pages). Not claimed: reader view, sales, statement. A new section names `UMS_PUBLISHER_PASSCODE_HASH` (name only) and says
  how to make a hash with `owner:secrets` and use the publisher passcode for the three publisher personas.
- D6: `lib/legal-copy.ts` publisher terms, "How a payee is checked": sandbox payments for the publishers that have articles
  on sale are received in the owners' one test account; a dry run pays nothing and the account endings are demo values.
  Golden `golden/legal-copy.golden.txt` regenerated for that one line. No other pinned test had the wrong copy.
- D9: `composition.server.ts` `publisherHome` counts an offer as live only when an enabled corridor covers its currency and
  the publisher's country (same rule as buyer discovery). `lib/publisher-copy.ts` `payeeText` says "Marked as checked" in
  place of "Verified" (legal text says "marked as checked"). Publisher copy golden updated for those two lines.
- D12: `orderMessage` agrees with the number of items ("Your items are"); the no-tick error says "before buying" and the
  pack error shows next to the Buy button; the item page shows plain payment words (`moneyStateText`, reusing the order
  line words) under the label "Payment".

Acceptance tests (run from the worktree root):

- `corepack pnpm exec vitest run --project unit apps/web/src/gate12-copy.test.ts` : all pass.
- `corepack pnpm exec vitest run --project golden apps/web/src/legal-copy.golden.test.ts apps/web/src/publisher-copy.golden.test.ts` : pass.
- `corepack pnpm exec vitest run --project state apps/web/src/publisher-shell.state.test.ts apps/web/src/payments.state.test.ts` : pass,
  including Northfield `offers_live` 0 and a two item single publisher order saying "Your items".
- `corepack pnpm lint`, `typecheck`, `format --check`, `check:isolation`, `check:no-live-host`, `check:secrets-names` : clean.

Do not: edit `globals.css`; touch money path code; add a dependency; change a contract.

Owner list (not changed here): the discover card says "This purchase does not include use with AI tools." for `ai_scope`
`review` while the receipt shows the stored value `review`; the owners decide one wording for both.
