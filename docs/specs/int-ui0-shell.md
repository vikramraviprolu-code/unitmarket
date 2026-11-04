# INT-UI0: console shell and shared UI

Task: One shell for operator, buyer and seller, the moved pages, and the shared pieces every later screen uses.
Package: `apps/web` (components, app routes, lib copy). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: UI0.1 to UI0.7, 12 points. Needs decision V2. Sources: `/mnt/project-files/operator-ux/recommendation.md` and the three HTML pages (Option A), UX-17, UX-18.

## Goal

The operator sees lasting tabs Home, Buyers, Sellers, Money, Agents and API, Controls; the buyer Home, Find, Library, Spending, Agents; the seller Home, Offers, Sales, Money, Account. Today's nine `/ops` blocks and pages live under those tabs with redirects from old URLs. Every order reference shows one display form with a copy control. Status words come from one dictionary. A timeline component renders TR1 entries (fixture data until TR1 lands). Each tab has its own composition module so Wave 2 lanes do not collide.

## Outputs

New: `apps/web/src/components/shell/{Shell,Tabs,SectionTabs,Breadcrumb,EnvPill,SearchSlot}.tsx`, `apps/web/src/components/{Ref,Timeline}.tsx`, `apps/web/src/lib/status-dictionary.ts`, `apps/web/src/composition/{ops-home,ops-money,ops-buyers,ops-sellers,ops-agents,ops-controls,buyer,seller}.ts`, tab route folders. Changed: `apps/web/src/app/ops/page.tsx` (split), `apps/web/src/lib/nav.ts`, `apps/web/composition.server.ts` (re-export the modules only), `apps/web/next.config` redirects or middleware.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| UI0.1 | `apps/web/src/shell.state.test.ts` | `pnpm test:state -- shell` | Tabs per persona; environment pill text comes from stored `environment` |
| UI0.2, UI0.3 | `apps/web/src/shell-redirects.test.ts`, e2e `tests/e2e/shell.spec.ts` | `pnpm test -- shell-redirects` | Every old `/ops`, `/publisher`, `/library` URL in the route inventory resolves; nine blocks visible under the new tabs |
| UI0.4 | `apps/web/src/ref.golden.test.ts` | `pnpm test:golden -- ref` | One format for every order reference |
| UI0.5 | `apps/web/src/status-dictionary.golden.test.ts` | `pnpm test:golden -- status-dictionary` | Every `orders.status`, `order_units.status`, refund and case state has word, meaning, who acts next, usual time |
| UI0.6 | `apps/web/src/timeline.test.tsx` | `pnpm test -- timeline` | Renders fixture entries in order, actor and channel visible, empty and error states |
| UI0.7 | `scripts/composition-split.test.ts` | `pnpm test -- composition-split` | Each tab module exports only its tab's reads; `composition.server.ts` holds no new logic |

Accessibility: axe check on each new tab page, light and dark screenshots attached.

## Do not

Change any API, domain or migration; change the PayPal start or stop controls; hard-code "Sandbox" or "Dry run".

Branch: `feat/int-ui0-shell`. Commit: `feat(web): shared console shell, tabs and shared components (INT-UI0)`.
