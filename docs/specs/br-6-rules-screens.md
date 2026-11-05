# Spec: operator "Business rules" screens (BR-6, UNI-80)

Task: operators see and change business-rule settings from the console, and can explain any sale's terms.
Package: `apps/web` (new `app/ops/rules/*`, one export route, composition read models) Owner: builder (Sonnet) Reviewer: Opus (M)
Branch: `feat/rules-screens` Commit: `feat(web): business rules screens (BR-6)` Depends on: BR-2, BR-3. Decision: D-096.

Goal: the refund window can be changed from the dashboard, for the platform or one seller or buyer, without a deploy, and anyone
on the ops team can see why a given order has the terms it has.

Design (existing CSS classes only, no new dependency, server components as in `app/ops/publishers`):

- `/ops/rules` (`app/ops/rules/page.tsx`): one row per registry key: current platform value, safe range, scopes allowed, count of active
  seller and buyer overrides, last change (who, when, reason). Data from `engine.opsRules.history` and `engine.rules.activeRows`.
- `/ops/rules/new` (`page.tsx` plus a client form component): key, scope kind, seller or buyer id, value, effective from, optional until,
  reason. Before submit it shows: "Applies to new sales from <date>. Sales already approved keep their terms." It posts through
  `apps/web/src/lib/client-api.ts` (the one file allowed to use fetch, S2) to `POST /api/ops/rules` (BR-2) with the second factor and an
  Idempotency-Key. Errors shown with reader-safe text.
- `/ops/rules/history`: filter by key, scope, operator; newest first; 200 rows on screen (BR-2 default limit).
- CSV export: `apps/web/src/app/api/ops/rules/export/route.ts`, `GET`, `auth: 'operator'`, in the route inventory through its
  `routeMeta`. `withRoute` answers JSON only, so it returns `{ filename, csv, truncated }` like `api/publisher/export/route.ts`. It calls
  `listRuleHistory` with `limit: 5000` (BR-2 maximum); `truncated` is true when more rows exist. Cells starting with `=`, `+`, `-`, `@`
  are prefixed with `'`.
- `/ops/rules/explain?order=<id>`: the order's snapshot `terms` (value and source per key, `rules_version`, digest), or "Approved before
  terms were recorded" for version 1 orders. Operator only; ids validated with `IdSchema`.
- Copy in new `apps/web/src/lib/ops-rules-copy.ts`. Link from the ops home: add an entry in `apps/web/src/lib/nav.ts` (ops items) and
  a card in `apps/web/src/app/ops/page.tsx`. No publisher or buyer access to any of these routes.

Tests first: `apps/web/src/ops-rules-pages.state.test.ts` (each page renders for an operator, refuses buyer, publisher and anonymous;
form posts with MFA; impact line present; explain shows sources; old order message; export returns the JSON shape);
`apps/web/src/ops-rules-copy.golden.test.ts`; `apps/web/src/ops-rules.adversarial.test.ts` (order id injection refused, export over
5000 rows sets `truncated`, formula strings in reason escaped in CSV, XSS strings in reason rendered as text).

Acceptance: those tests plus the six suites pass, red run first; `check:routes`, `check:no-live-host`, `check:secrets-names`, lint,
typecheck, format pass; screenshots light and dark.
Do not: add agreement or category editors (later lanes); edit `globals.css`; add a write path other than the BR-2 route.
Evidence: red and green runs, four screenshots.
