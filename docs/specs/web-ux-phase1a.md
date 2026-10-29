# Spec: screens Phase 1A, the safe quick wins (UX review, owner go on 30 Oct 2026)

Task: four fixes from the UX review that change copy and CSS only on non-money pages: the library time
contradiction, the stray focus ring, the terms shown where they are accepted, and the fit card at mid widths.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus, one round (D-048); the coordinator merges.
Branch: `feat/web-ux-phase1a` Commit: `feat(web): <what> (UX-1A)` Decisions: D-051 (wording rules stay).
Detail source (read only, may help): `/tmp/claude-0/-home-user/e5712637-4fe0-5e9e-992f-655f773ad1bf/scratchpad/ux-review/`
files `02-problems.md`, `03-proposals.md`, `04-plan.md`, `05-style-spec.md`.

Goal: the four problems below are gone, with tests, and no money-path page changes its markup or its words.

Requirements (tests first, commit 1 holds only tests and is run red; then implement to green):

1. U1, library card (`ui/WindowMeter.tsx`): the card shows one statement of the time left. Remove the bold
   "N days left" line that contradicts "Ready, 4 days 23 hours left" (one rounds up, one rounds down). Keep
   "Access until <date>" or "Download until <date>" and the meter. Keep every `data-testid` (`library-item`,
   `library-status`, `window-meter`).
2. U2, focus (`app/globals.css`): add `main:focus { outline: none; }`. Keep the 3 px `:focus-visible` outline on controls.
3. U3, terms (`DiscoverForm.tsx`, new `lib/buyer-copy.ts`): under the terms tick add a `<details>` whose summary is
   "What the terms say" and whose text states: personal use only, no redistribution, five days of access starting when
   payment is confirmed, and that the price and terms are held for 15 minutes once the buyer starts to buy. Reuse existing
   wording where it exists. The tick stays unticked by default and its label text is unchanged.
4. U4, fit card (`ui/FitCard.tsx`, `globals.css`): (a) below 760 px the fit rows reflow so no row breaks into one word per
   line; (b) the "not assessed" rows move into a `<details>` named "Why this fit", open state off; the rows that carry a
   real assessment stay visible; (c) the price line reads "$1.20 · Read online" with "5 days to read" (or "5 days to
   download your copy") under it, never "for read online". Do not change the fit band; it comes from `domain/fit`.

Acceptance (run, paste output): `corepack pnpm exec vitest run --maxWorkers=2 apps/web`; `corepack pnpm test:state`;
`corepack pnpm test:golden`; `corepack pnpm lint`; `corepack pnpm format:check`; `corepack pnpm typecheck`;
`corepack pnpm check:isolation`; `corepack pnpm check:secrets-names`; `corepack pnpm check:no-live-host`. If the Playwright
end-to-end suite can run in your sandbox without a network, run `corepack pnpm test:e2e` too; otherwise say so.

Do not: change the markup or wording of `approve`, `checkout`, `orders`, `receipts` or `cancel` pages; touch domain, contracts
or packages; add a dependency; use inline `style` attributes (the CSP forbids them); contact any network or PayPal; read a real
secret or any `.env.local`; run `pkill`; run a suite without `--maxWorkers=2`; edit an existing test except where it pins a
string this spec changes (name each in your hand-back).
Disk: about 2.5 GB free; run `df -h /home` before heavy steps and stop under 400 MB; remove only your own temp folders.
Evidence: commands with output, the list of tests you changed and why, screenshots of the library card and the fit card at
1280 and 400 px if you can take them with the pre-installed Chromium, and a cost line.
