# INT Wave 2 and 3: shared conventions (part of every Wave 2 and E2E spec)

Every Wave 2 spec (OPS-A, OPS-B, OPS-C, CTL, BUY, SEL, GA) and E2E includes these rules by reference. They come from the Wave 0 and 1 scoring rounds (scorecards in this folder), checked against sandbox `main` 4b9af11.

## C1 Commands

- A unit, state, contract, golden or adversarial file runs with `corepack pnpm vitest run <path> [<path> ...]`. Never use `pnpm test:x -- name`: vitest takes words after `--` as passthrough and runs the whole suite.
- e2e specs live in `apps/web/e2e/` and run with `corepack pnpm --filter @umsbx/web test:e2e <file>.spec.ts`.
- Real-Postgres tests set `UMS_TEST_PG_BIN=$(pg_config --bindir)`. A skip counts as a fail, and the output shows the run count.
- Mutation: `pnpm mutation --require-targets --targets a.ts,b.ts --test-cmd "<vitest run paths>" --threshold 80`.

## C2 Screens and tests

- Vitest cannot import `.tsx` (`jsx: preserve`). All logic a test checks lives in pure `apps/web/src/lib/*-view.ts` or `*-copy.ts` files. Components stay thin.
- Rendering is proven in e2e, or by reading the component as text (the `skin.state.test.ts` method).
- Components go in `apps/web/src/ui/` (shared) or `apps/web/src/ui/<persona>/`, never `src/components/`.
- Accessibility: no axe-core (not in D-008, deferred by D-066). Use the text-read check of `flow-a11y.state.test.ts` (labelled landmarks, `aria-current`, labels on inputs), plus a light and a dark screenshot of each new page.
- Each page imports reads only from its tab's composition module, `apps/web/src/composition/<tab>.ts` (UI0.7). `composition-split.test.ts` must stay green.
- If a needed lane has not merged, the builder stops and reports. It never builds a substitute.

## C3 Routes and identity (the SR1, TR1 and AL rule)

- Browser writes use session routes under `/api/ops/*`, `/api/buyer/*` or `/api/publisher/*`. Each has `auth` of `operator`, `buyer` or `publisher`, plus `csrf: true` and `idempotent: true`. Operator writes are `risk: 'high'`, and the wrapper demands MFA on every operator POST.
- `/api/v1/*` stays the partner API (apikey). No `/api/v1/ops/*` route writes or carries buyer or publisher identity or PayPal ids.
- Operator screens show identity only on MFA sessions, through the session routes and composition functions that apply `operatorView({mfa})` (TR1) or `withOpsIdentity` (SR1).
- Sellers never see buyer identity (id, name, agent key or trace context) in props, HTML or JSON. Every seller page has a deep-scan adversarial case.
- Environment labels come from stored `environment` through `src/ui/EnvLabel.tsx`, never from a literal.

## C4 Safety (every lane)

- No PayPal call, credential, account, approval row or secret.
- No change to `packages/transport`, `packages/paypal` or `endpoints.ts`. The five locks are untouched. Nothing sets `UMS_PAYPAL_CONNECT` or inserts `outbound_approvals`.
- The gate runs `corepack pnpm check:no-live-host`, `check:secrets-names`, `check:isolation`, `check:routes` and `check:openapi`, and the offline proof: no fetch, socket or DNS during the suites.

## C5 Integrity gate (every lane, TR0 onward)

`pnpm trace:verify` exits 0, and INV-T2 (unattributed rows) is empty after the seed, the lane's tests and its journeys. Every new write path runs inside a trace context: route, job or CLI.

## C6 Existing tests

A test that asserts an old place or old words is moved to the new URL or words, never weakened. The PR lists each changed test with a one-line reason. Guard tests stay unchanged: `ops-start.*`, `refund.*`, `operator-mfa.*`, `e2e/zz-ops-stop.spec.ts`.

## C7 Evidence

Red output of commit 1; green `corepack pnpm run ci`; `trace:verify` output; the mutation result for each L item; light and dark screenshots for each new page; sanitised ids only.
