# Overnight plan, 30 to 31 Oct 2026: lanes, file ownership, order and checks

Written by the lane spec planner under D-065 and D-066. It plans work only; nothing here is built. Every lane has a
one-page spec in `docs/specs/`. Opus reviews every lane before the coordinator merges it; builders push branches and never
merge or open pull requests.

## 1. Lanes

| Id       | Spec                                | What                                                                   | Review focus                   |
| -------- | ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| CFG-0    | `config-overnight-names.md`         | Four config names: publisher hash, offer cap, AI adapter, AI key       | refusals, secret handling      |
| PUB-A1   | `pub-a1-personas-shell.md`          | Migration 0012, three publisher personas, `/publisher` shell           | isolation, migration           |
| PUB-A2   | `pub-a2-payee.md`                   | S6 "Where you get paid", payee requests, operator verify with MFA      | money path: who gets paid      |
| PUB-B    | `pub-b-offer-revise-withdraw.md`    | Revise and withdraw as new versions, S2, S3, demo prices               | money path: snapshot freeze    |
| PUB-C    | `pub-c-sales-statement.md`          | `domain/publisher-console` reads, S4 sales, S5 statement               | sums against the ledger        |
| PUB-D    | `pub-d-ops-publishers.md`           | S7 `/ops/publishers`, exposure, suspend                                | operator authorisation         |
| AI-A     | `ai-a-model-adapter.md`             | Claude adapter, one egress host, spend caps, injection set             | egress, spend                  |
| AI-B     | `ai-b-evals-page.md`                | `/ops/evals` with case count and keyword baseline                      | honesty of figures             |
| LEGAL-A  | `legal-a-pages.md`                  | Four draft legal pages, footer links, sign-in privacy notice           | wording                        |
| SKIN-A   | `skin-a-system.md`                  | Skin system, cookie, Appearance control, Bright Market, contrast tests | CSP, contrast                  |
| SKIN-B   | `skin-b-harbour-motion.md`          | Deep Harbour tokens, shippable motion set                              | reduced motion, still approval |
| READER-A | `reader-a-view.md`                  | In-app reader with the time-left meter                                 | delivery evidence              |
| DOCS-A   | `docs-a-threat-privacy-keyboard.md` | Threat model, privacy script spec, keyboard checklist                  | traceability                   |
| DOCS-B   | `docs-b-submission-deploy.md`       | Submission text, testing instructions, deploy prep                     | accuracy, no values            |

Splits against the request: pub-a became PUB-A1 and PUB-A2 (too large for 90 minutes; the payee half must merge before the
2 Nov freeze); the demo prices moved to PUB-B (they are offer revisions); the evals page left AI-A as AI-B; the reader left
SKIN-B as READER-A (different reviewer focus); docs-close-out became DOCS-A and DOCS-B. CFG-0 is new: it keeps three lanes
out of `packages/config` at the same time.

Already in flight and counted against the three builders when active: UX-1A (`feat/web-ux-phase1a`, decision 42, WIP in
`/home/user/sbx-wt-ux1a`), repo compliance (`feat/repo-compliance`: LICENSE, README, `package.json` licence, decisions 7, 8, 11).
Paused: WordPress E-L1 (`feat/offer-entry-signed-link`, touches `domain/offer-entry`).

## 2. Common rules for every overnight lane

The shared builder brief applies in full; the points a spec relies on:

- Own worktree `git worktree add /home/user/sbx-wt-<lane> -b <branch> origin/main`; `corepack pnpm install
--frozen-lockfile`. Remove the worktree's build output after push if `df -h /home` shows under 1 GB.
- Tests first: commit 1 holds only tests and data and is run red (show it). Never edit a test to make it pass unless it
  contradicts the spec; name each one. Touch only the files the spec lists; a missing interface is a stop and report.
- No PayPal call, no model call, no approval row, no account, key or secret; never open an env file other than
  `.env.example`. CLI commands that touch safety or the app get the `env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT` prefix.
- No new dependency (D-008). No inline `style` attributes, system fonts only, no external scripts, fonts or images, no `data:`
  URIs. No italics and no dash characters in user-facing copy. Labels Sandbox or Dry run from stored data. D-051 wording.
- UI pattern of this repo: the unit runner does not compile `.tsx`. User-facing copy lives in `apps/web/src/lib/*-copy.ts`
  and is golden-pinned; tests read page sources as text (as `order-pages.state.test.ts` does) and drive the engine through
  `bootTestApp` in `apps/web/src/support.ts`. Every route is `withRoute(routeMeta, ...)` and must pass `check:routes`.
- Every query in a publisher lane filters by the actor's `publisher_id` in SQL; another publisher's id answers 404.
- Composition: each lane adds its engine methods as one contiguous block and rebases on `main` right before review.
- Commit `type(<package>): <what> (<lane id>)` with the trailers of the brief; push the branch; no merge, no PR; 90 minutes.

## 3. Check commands

Common list, run one at a time in the lane's worktree, all green before push (known: `test:state` has 1 expected failure):

```
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm check:isolation
corepack pnpm check:no-live-host
corepack pnpm check:secrets-names
corepack pnpm check:routes
corepack pnpm check:provenance
corepack pnpm test:unit
corepack pnpm test:state
corepack pnpm test:contract
corepack pnpm test:integration
corepack pnpm test:adversarial
corepack pnpm test:golden
```

| Lane           | Extra checks (from its spec)                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CFG-0          | `test:unit packages/config`, `test:contract packages/config`, `check:hosting`, `check:hosting-gcp`                                                                                   |
| PUB-A1         | `test:state packages/db apps/web`, `test:adversarial apps/web`, `test:golden apps/web`                                                                                               |
| PUB-A2         | `test:state domain/catalogue apps/web`, `test:adversarial domain/catalogue apps/web`, `test:golden apps/web`                                                                         |
| PUB-B          | as PUB-A2                                                                                                                                                                            |
| PUB-C          | `install --frozen-lockfile` after the lock update, `test:unit domain/publisher-console`, `test:state domain/publisher-console apps/web`, `test:adversarial domain/publisher-console` |
| PUB-D          | `test:state domain/publisher-console domain/catalogue domain/offer-entry apps/web`, `test:adversarial apps/web domain/offer-entry`                                                   |
| AI-A           | `test:unit packages/transport packages/model`, `test:state packages/model apps/web`, `test:adversarial packages/transport packages/model`                                            |
| AI-B           | `test:state apps/web`, `test:adversarial packages/model`, `test:golden apps/web`                                                                                                     |
| LEGAL-A        | `test:state apps/web`, `test:golden apps/web`                                                                                                                                        |
| SKIN-A, SKIN-B | `test:unit apps/web`, `test:state apps/web`, `test:golden apps/web`; `test:e2e` if it runs offline                                                                                   |
| READER-A       | `test:state apps/web`, `test:adversarial apps/web`, `test:golden apps/web`; `test:e2e` if offline                                                                                    |
| DOCS-A, DOCS-B | only `format:check` (or `prettier --check` on the files), `check:no-live-host`, `check:secrets-names`                                                                                |

All extra checks are `corepack pnpm <script> <paths>`; pnpm passes the paths to vitest with `--maxWorkers=2` already set.
Never run plain `vitest run`.

## 4. File ownership map (who touches what; shared files are sequenced)

| File or area                                                                                                         | Lanes                                                                       | Sequencing                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/config/src/{schema,load}.ts`, `.env.example`                                                               | CFG-0                                                                       | only lane                                                                                                              |
| `packages/db/migrations/common/0012_publisher_side.sql`, `packages/db/src/schema.state.test.ts`                      | PUB-A1                                                                      | only lane; any later migration is 0013 and rebases on it                                                               |
| `apps/web/composition.server.ts`                                                                                     | PUB-A1, PUB-A2, PUB-B, PUB-C, PUB-D, AI-A, AI-B, READER-A                   | build in parallel, merge in the order of section 5, each rebased first; conflicts are adjacent added blocks, keep both |
| `apps/web/src/app/layout.tsx`                                                                                        | PUB-A1 (nav link), LEGAL-A (footer links), SKIN-A (`data-skin`, Appearance) | SKIN-A after both                                                                                                      |
| `apps/web/src/app/globals.css`                                                                                       | UX-1A, SKIN-A, SKIN-B, READER-A (one block, optional)                       | UX-1A, then SKIN-A, then SKIN-B; READER-A after SKIN-A or no CSS; publisher lanes never edit it                        |
| `apps/web/src/app/signin/SignInForm.tsx` / `signin/page.tsx`                                                         | PUB-A1 / LEGAL-A                                                            | different files                                                                                                        |
| `apps/web/src/app/ops/page.tsx`                                                                                      | PUB-D (link), AI-B (link)                                                   | one line each; second rebases                                                                                          |
| `apps/web/src/app/library/**`, `apps/web/src/ui/WindowMeter.tsx`                                                     | UX-1A, READER-A                                                             | READER-A after UX-1A                                                                                                   |
| `apps/web/src/app/discover/DiscoverForm.tsx`, `apps/web/src/ui/FitCard.tsx`                                          | UX-1A only                                                                  | LEGAL-A and SKIN lanes stay out                                                                                        |
| `apps/web/src/support.ts`                                                                                            | PUB-B (`demo_prices: false`)                                                | only lane                                                                                                              |
| `apps/web/src/golden/skin-tokens.golden.txt`                                                                         | SKIN-A creates, SKIN-B updates                                              | SKIN-B after SKIN-A                                                                                                    |
| `domain/catalogue/src/index.ts`                                                                                      | PUB-A2, PUB-B, PUB-D                                                        | merge order; one export line each                                                                                      |
| `domain/catalogue/src/read.ts`, `domain/offer-entry/src/start.ts`                                                    | PUB-D (and paused E-L1)                                                     | E-L1 rebases on PUB-D when resumed                                                                                     |
| `domain/publisher-console/**`                                                                                        | PUB-C creates, PUB-D adds `exposure.ts`                                     | PUB-D after PUB-C                                                                                                      |
| `eslint.config.mjs`, `pnpm-lock.yaml`, `apps/web/package.json`                                                       | PUB-C                                                                       | only lane (AI-A must not need a lint change; if it does, it stops and reports)                                         |
| `packages/contracts/src/ports.ts`, `packages/transport/src/{index,model-https}.ts`                                   | AI-A                                                                        | only lane                                                                                                              |
| `packages/model/**`                                                                                                  | AI-A, AI-B (`eval-checks.ts`, helper move)                                  | AI-B after AI-A                                                                                                        |
| `docs/design/threat-model.md`, `docs/specs/ops-privacy-export-delete.md`, `docs/evidence/keyboard-pass-checklist.md` | DOCS-A                                                                      | only lane                                                                                                              |
| `docs/submission/**`, `docs/owner/DEPLOY-PREP-2026-11.md`                                                            | DOCS-B                                                                      | only lane, last                                                                                                        |

## 5. Order, parallel waves, merges

Dependencies: CFG-0 before PUB-A1, PUB-B, AI-A. PUB-A1 before PUB-A2, PUB-B, PUB-C. UX-1A and LEGAL-A before SKIN-A.
SKIN-A before SKIN-B. UX-1A before READER-A. AI-A before AI-B. PUB-A2, PUB-B, PUB-C before PUB-D. Everything before DOCS-B.

Waves, at most three builders at once (in-flight UX-1A takes a slot while it runs):

1. CFG-0 (short), LEGAL-A, DOCS-A (or UX-1A instead of DOCS-A if it resumes now).
2. PUB-A1, AI-A, then DOCS-A or UX-1A in the free slot.
3. PUB-A2, PUB-B, SKIN-A.
4. PUB-C, AI-B, READER-A.
5. PUB-D, SKIN-B.
6. DOCS-B.

Merge order: CFG-0, LEGAL-A, DOCS-A, UX-1A, PUB-A1, AI-A, PUB-A2, PUB-B, SKIN-A, PUB-C, AI-B, READER-A, PUB-D, SKIN-B,
DOCS-B. Deadline: PUB-A2 and AI-A merge before the Mon 2 Nov freeze (item 31 covers the payee and the transport package);
if they slip, they need an owner exception row.

## 6. Conflicts with decisions or rules (flagged, not worked around)

1. AI-A against architecture section 1 ("No Claude API ... ever in this design"), zone Z4 (PayPal hosts only), 9.10 ("a
   later, separately approved lane") and architecture 2.3 S2 ("only `packages/paypal` imports transport"; CLAUDE.md also
   allows composition). D-065 approves items 14 to 16 only as working assumptions; no row amends the architecture. The
   coordinator records a decision row (and the architecture edit) before AI-A merges. Vikram confirms on 31 Oct.
2. D-066 says "`ai_enabled` off" but the existing `ai_enabled` switch gates discovery itself and is seeded on; turning it off
   stops Find. The specs keep the switch as is and make "off" mean `UMS_AI_ADAPTER=scripted` (the default). Owner to confirm.
3. PUB-A2 against D-062, D-028 and D-041: an operator verifying a new, unshared merchant id on the hosted app would put a
   named payee into `create_order`. Correction (traceability MT-5): the transport seal does not block that under the D-062
   scope (`mvp_c_refunds`), which allows a payee, and the approval row has no payee field. What stops a second payee today is
   data (both selling publishers hold the owner's merchant id), the spec's refusal of verification outside a dry run, and
   that no owner command to switch a payee is merged. A scope that names one payee is the planned fix (PAYEE-SCOPE). D-062 does
   not approve a second payee, so paying one needs a new owner decision (items 28 and 30).
   The Quayside switch (item 28) needs a separate owner TTY command lane plus a new approval row (item 30); not specced here.
4. Demo prices (item 37): editing `seed-data.ts` would ripple through about 20 test files that pin 40, 90, 300 or 450 minor
   units. The spec applies them as audited offer revisions at boot instead. On the hosted database the first boot after
   deploy writes new offer versions (catalogue data, open under item 31). `apps/web/e2e/journeys.spec.ts` may pin old prices.
5. SKIN-A removes the `prefers-color-scheme: dark` block (each skin is one fixed palette; the style spec kept dark mode "as
   today"). A visitor who prefers dark sees Bright Market until they choose Deep Harbour. Owner to confirm.
6. Hosted gaps: `infra/gcp/deploy.sh` maps only its listed secrets, so on the hosted app publisher personas
   (`UMS_PUBLISHER_PASSCODE_HASH`) and the Claude adapter stay off until a reviewed infra change (a small INFRA-A lane, not
   specced tonight) and the owner's `set-secret.sh` run (H). Judges on the hosted URL will not see the publisher console
   until then.
7. PUB-D does not change `domain/approval` (money path): if approval does not re-read the catalogue, a suspended publisher's
   offer can still be approved inside an open 15-minute freeze. Logged as a follow-up, not fixed silently.
8. Supabase policies for the new tables and the recorded `payee_shared` revoke gap (READINESS) are not done: Supabase is
   unused (D-049). Follow-up.
9. Item 50 (a link to the terms at the tick) and item 19 (injection result in the README) fall in files owned by UX-1A and the
   repo compliance lane. Follow-ups after those merge.
10. Model prices in AI-A (USD 0.10 and 0.50 per million tokens, Haiku 5.5) come from a cached reference dated 6 Oct 2026; the
    owner checks the pricing page before switching the adapter on.
11. Disk: 3.2 GB free at writing. Three worktrees with installs and a Next build can pass 1.5 GB; builders clear `.next`
    after each run.
