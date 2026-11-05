# INT-UI0: console shell and shared UI, round 2 (passed 11 of 12, with builder notes)

Task: One shell for operator, buyer and seller, with today's operator blocks placed under tabs, and the shared pieces every later screen uses.
Package: `apps/web` (pages, `src/ui`, `src/lib`, `src/composition`), plus one additive const in `packages/contracts`. Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: UI0.1 to UI0.7, 12 points. Decision V2. Sources: `/mnt/project-files/operator-ux/recommendation.md` (Option A), UX-17, UX-18. Round 2 answers `ui0-scorecard.md` findings 1 to 13, and SR0 note R2-3.

## Goal

**UI0.1, the shell.**

- Each persona gets lasting tabs, a breadcrumb, an environment pill read from stored data, a `/` search slot and, at phone width, a bottom tab bar.
- Operator tabs: Home `/ops`, Buyers `/ops/buyers`, Sellers `/ops/sellers`, Money `/ops/money`, Agents and API `/ops/agents`, Controls `/ops/controls`.
- Buyer tabs: Home `/buyer`, Find `/discover`, Library `/library`, Spending `/buyer/spending`, Agents `/buyer/agents`.
- Seller tabs: Home `/publisher`, Offers `/publisher/offers`, Sales `/publisher/sales`, Money `/publisher/statement`, Account `/publisher/payout-account`. Seller URLs keep `/publisher`; labels say "Seller".
- A tab whose page another lane builds (operator Buyers and Agents in OPS-C; buyer Spending and Agents in BUY) stays hidden until its page exists. The `TABS` list carries a `ready` flag, so the shell never shows an empty "coming soon" tab.
- The public `/seller` apply page is unchanged.

**UI0.2 and UI0.3, the operator blocks.** Today's `/ops` blocks move under the operator tabs as they are. Old links keep working (table below).

**UI0.4, references.** Every order reference has one display form with a copy control.

**UI0.5, status words.** One dictionary gives every raw order, unit, refund and case state a word, a meaning, who acts next and a usual time. The six group words (paid, refunded and so on) are not defined here: they come from SR0's `STATUS_GROUPS` in contracts, and screens that show groups (OPS-B, BUY, SEL) import them from there.

**UI0.6, timeline.** A timeline component renders entries of TR1's shape from fixtures until TR1 lands.

**UI0.7, composition.** Each tab has its own composition module, so Wave 2 lanes do not collide.

## Where the blocks go, and old links (findings 4, 5)

The server never sees a `#fragment`, so there are no redirects. `/ops` becomes Operator Home. For each block that moves, Home keeps a stub `<section id="...">` holding one sentence and a link to the new place, so an old bookmark lands on the stub. `/ops/publishers`, `/ops/payee-requests` and `/ops/evals` keep their URLs, and show under the Sellers or Controls section tabs.

| Old                                                                                | New                              | Method                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ops#ops-kill` (kill switch)                                                      | stays on `/ops`                  | unchanged; the emergency stop stays on Home                                                                                                                            |
| `/ops#ops-alerts`                                                                  | stays on `/ops`                  | unchanged                                                                                                                                                              |
| `/ops#ops-switches`                                                                | `/ops/controls#ops-switches`     | stub on Home                                                                                                                                                           |
| `/ops#ops-gate-section`                                                            | `/ops/controls#ops-gate-section` | stub on Home                                                                                                                                                           |
| `/ops#ops-refunds`, `#ops-orders`, `#ops-totals`, `#ops-states`, `#ops-invariants` | `/ops/money#<same id>`           | stub on Home                                                                                                                                                           |
| `/ops#ops-shared-payee`                                                            | `/ops/sellers#ops-shared-payee`  | stub on Home. Today this is a `data-testid` on a conditional `<p>` (`app/ops/page.tsx:167`), so the builder adds the `id` on Sellers, and the Home stub always renders |
| `/ops/publishers`, `/ops/payee-requests`                                           | same URL, under the Sellers tab  | section tab                                                                                                                                                            |
| `/ops/evals`                                                                       | same URL, under the Controls tab | section tab                                                                                                                                                            |
| `/publisher/*`, `/library`, `/account`, `/discover`, `/buyer`                      | same URLs                        | tabs only                                                                                                                                                              |

The table lives as data in `apps/web/src/lib/shell-moves.ts`; tests read it.

## Safety (finding 9)

- The kill switch, feature switches, outbound gate panel and refund panel move as they are: same components, MFA, CSRF and copy.
- No API, domain or migration change. Nothing sets `UMS_PAYPAL_CONNECT` or inserts `outbound_approvals`.
- The pill text comes from the stored `environment` through `src/ui/EnvLabel.tsx`, never a literal "Sandbox" or "Dry run".
- These guard tests must pass unchanged: `src/ops-start.*.test.ts`, `src/refund.*.test.ts`, `src/operator-mfa.integration.test.ts`, `e2e/operator-mfa.spec.ts`, `e2e/refund.spec.ts`, `e2e/zz-ops-stop.spec.ts`. A guard whose page moved (the refund panel to `/ops/money`) changes its URLs only; every assertion stays, and the PR lists it (decided 5 Nov).
- The gate runs `corepack pnpm check:no-live-host`, `check:secrets-names`, `check:routes` and `check:isolation`.

## Outputs (only these files)

New:

- `src/ui/shell/{Shell,Tabs,Breadcrumb,SearchSlot,PhoneBar}.tsx`, `src/ui/{Ref,Timeline}.tsx`
- pure logic: `src/lib/{shell-tabs,shell-moves,breadcrumb,ref-format,timeline-view,status-dictionary}.ts`
- pages: `src/app/ops/{money,sellers,controls}/page.tsx` (operator Buyers and Agents come from OPS-C)
- `src/composition/{ops-home,ops-money,ops-buyers,ops-sellers,ops-agents,ops-controls,buyer,seller}.ts`. The existing reads move here unchanged; `ops-buyers` and `ops-agents` start empty.
- the tests below

Changed:

- `src/ui/EnvLabel.tsx`, `src/ui/SectionNav.tsx` (extended, not copied)
- `src/app/ops/page.tsx` (Home plus stubs); `src/app/layout.tsx` (shell)
- `src/lib/nav.ts`, `src/lib/publisher-copy.ts` (`PUBLISHER_NAV_LABEL` = "Seller"; UI0 owns this rename in nav and tabs; SEL renames page copy)
- `composition.server.ts` (re-exports only)
- `packages/contracts/src/payments.ts` (additive `REFUND_REQUEST_STATES` const: `requested`, `sent`, `unknown`, `pending`, `unresolved`, `completed`, `failed`, `cancelled`, `rejected`, the values `domain/payments/src/refunds.ts` writes (lines 75, 78, 284, 342, 527, 586, 711, 771); there is no DB CHECK, so the PR cites these lines)
- tests that assert old places, moved to the new URL and never weakened: `e2e/zb-section-tabs.spec.ts`, `e2e/site-shell.spec.ts`, `e2e/header-layout.spec.ts`, `e2e/publisher-pages.spec.ts`, `e2e/zd-ops-publishers.spec.ts`, `src/ops-home-copy.test.ts`, `src/ops-home-copy.golden.test.ts`, `src/publisher-copy.golden.test.ts` and `src/publisher-shell.state.test.ts` (the "Publisher" nav label)

## Acceptance tests (commit 1: tests only, run red)

| Item         | Test file                                                                         | Command                                                                                                                       | Expected                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI0.1        | `apps/web/src/shell-tabs.golden.test.ts`, `apps/web/src/shell-a11y.state.test.ts` | `corepack pnpm vitest run apps/web/src/shell-tabs.golden.test.ts apps/web/src/shell-a11y.state.test.ts`                       | Tabs per persona and URL as above; hidden tabs have `ready: false`; `breadcrumbFor` gives the right trail for 12 paths. A text read of the shell files (the `flow-a11y.state.test.ts` method) finds a labelled `nav`, `aria-current="page"` on the active tab, a phone-bar rule under `@media (max-width: 640px)`, and no literal "Sandbox" or "Dry run"                                                                         |
| UI0.2, UI0.3 | `apps/web/src/shell-moves.state.test.ts`, `apps/web/e2e/shell.spec.ts`            | `corepack pnpm vitest run apps/web/src/shell-moves.state.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e shell.spec.ts` | For each row of `shell-moves.ts`: the new page's source has the block's `id`, and Home's source has the stub with a link to the new place. e2e: each old anchor URL lands on its stub; the stub link reaches the block; at 390 px wide the bottom bar shows; pressing `/` focuses the search slot and sends no request; the breadcrumb shows on `/ops/money`                                                                     |
| UI0.4        | `apps/web/src/ref-format.golden.test.ts`                                          | `corepack pnpm vitest run apps/web/src/ref-format.golden.test.ts`                                                             | One display form for order refs, including the short ref (last 6); copy text equals the full ref                                                                                                                                                                                                                                                                                                                                 |
| UI0.5        | `apps/web/src/status-dictionary.golden.test.ts`                                   | `corepack pnpm vitest run apps/web/src/status-dictionary.golden.test.ts`                                                      | Keys equal `OrderStatusSchema.options`, `UnitStatusSchema.options`, `REFUND_REQUEST_STATES` and `CaseStateSchema.options` exactly, so a new state fails; each entry has word, meaning, who acts next and usual time                                                                                                                                                                                                              |
| UI0.6        | `apps/web/src/timeline-view.test.ts`                                              | `corepack pnpm vitest run apps/web/src/timeline-view.test.ts`                                                                 | `TimelineEntryView` has exactly the TR1 entry fields; fixtures render in order with actor and channel words; empty and error states                                                                                                                                                                                                                                                                                              |
| UI0.7        | `apps/web/src/composition-split.test.ts`                                          | `corepack pnpm vitest run apps/web/src/composition-split.test.ts`                                                             | Each page under a tab imports only its tab's module; `composition.server.ts` gains only `export ... from './src/composition/...'` lines                                                                                                                                                                                                                                                                                          |
| Security     | `apps/web/src/shell.adversarial.test.ts`, plus `e2e/shell.spec.ts`                | `corepack pnpm vitest run apps/web/src/shell.adversarial.test.ts`                                                             | Every new `app/ops/**/page.tsx` starts with the same operator check as `/ops` (`redirect('/signin?next=...')`). In e2e, a buyer, seller and anonymous session each land on sign-in for each operator tab; a buyer or anonymous session is refused on seller tabs; seller tabs show no buyer identity; every href in `shell-tabs.ts` and `shell-moves.ts` is a relative path that `lib/next-path.ts` accepts (no `//`, no scheme) |

Accessibility: no axe-core (not in D-008; D-066). The text-read check above, plus light and dark screenshots of each tab at desktop and phone width, attached to the PR.

## Do not

Change any API, domain logic or migration; change the PayPal start, stop or gate controls, or their MFA and CSRF; hard-code an environment label; add `src/components/`; change `vitest.config.ts`; add a dependency.

Branch: `feat/int-ui0-shell`. Commit: `feat(web): shared console shell, tabs and shared components (INT-UI0)`.
