# INT-OPS-A: operator Home, alerts, cases and order page

Task: The operator screens that turn "something is wrong" into one click to the fix.
Package: `apps/web` (operator Home, Money › Problems, alerts, cases, order page, shell bell), plus the read side of four seller-queue functions in `domain/catalogue` and `domain/publisher-console`, and one additive field in `domain/payments` invariants. Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: OPS-A.1 to OPS-A.7, 12 points, all "must". Needs UI0, TR1 and AL merged. Decision V6. Sources: operator page items 6, 7, 7b, 9; UX-01, 02, 03, 06, 07, 08. Includes `int-wave2-conventions.md` (C1 to C7). Round 2 passed 12/12 (`ops-scorecard.md`); build notes below.

## Goal

**OPS-A.1, health lights.** Home shows four lights. Each word comes from one rule in `lib/ops-health-view.ts` (A5):

| Light          | Source                                                                 | Words                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App            | `engine.health()` answered                                             | "up"; if the read throws, "unknown"                                                                                                                        |
| Database       | `health().maintenance`, `health().db`                                  | maintenance: "closed for maintenance"; `db` true: "up"; false: "down"                                                                                      |
| PayPal gateway | `health().environment`, `outboundSwitchOn(actor)`, the outbound status | `dryrun`: "off (dry-run)"; switch off: "off (switched off)"; status open: "on"; locks closed: "blocked (<BLOCKED_BY word>)"; switch read `null`: "unknown" |
| Job loop       | `health().last_pass_at`, injected clock                                | null: "not run yet"; older than `JOB_STALE_MS = 300_000`: "stale"; else "running"                                                                          |

**OPS-A.2, needs-you and the bell.** Home shows AL's needs-you list. A new `src/ui/shell/AlertBell.tsx` in the operator shell only shows open alerts by severity; its counts come from AL's needs-you read through `ops-home.ts` (A4).

**OPS-A.3, alerts.** The alerts list filters by state, severity and kind (AL.1), with a "show resolved" toggle and true totals. Alert detail shows cause, money at risk, case link, the fix link (catalogue `fix`), and acknowledge, resolve with a reason code, and reopen. These post to AL's `/api/ops/alerts/[id]/*` routes.

**OPS-A.4, order page.** `/ops/money/orders/[ref]` shows a summary, the TR1 operator timeline, the evidence pack buttons and the one fix link from the catalogue. Identity appears only on an MFA session (C3).

- The "verified" mark is **not** OPS-A's: OPS-B.5 owns it in `Timeline.tsx` (S1).
- **Anchor (A7):** each timeline entry has id `seq-<n>` from its TR1 `seq`. An alert opens the order page at `#seq-<n>` of the entry with `source.table = 'alerts'` and `source.id = <alert id>`.
- **Evidence (A7):** TR1's pack is per unit, so the page shows one button per unit, each linking to `/api/ops/units/[id]/evidence.html` (MFA only; without MFA the button says "needs your authenticator code").

**OPS-A.5, cases.** `/ops/buyers/cases` (ordered by SLA due, filter by state) and the case detail with AL's six actions, posting to `/api/ops/cases/[id]/actions`. `buyer_message` is shown as plain system text (AL R2-2).

**Buyers tab (S2).** OPS-A creates `apps/web/src/app/ops/buyers/page.tsx` as a redirect to `/ops/buyers/cases`, and only then sets Buyers `ready: true` in `shell-tabs.ts`. OPS-C may later add a buyer search to that page.

**OPS-A.6, invariants and operations (A3).** Both targets are the Problems page `/ops/money/problems`:

- Each failing invariant on Money links to `/ops/money/problems?inv=<INV1..INV7>`. The page lists every order touched by that invariant, each linking to the order page. `domain/payments/src/invariants.ts` gains one additive field on its result, `rows: {table, id}[]` (all offending rows, not cut at five); `detail` and `ok` are unchanged. `ops-money.ts` resolves each row to its order ref.
- Each operation-state tile links to `/ops/money/problems?op=<state>` (a state from `OperationStateSchema`). The page lists those operations: id, kind, order ref, attempt, `lease_until`.
- `lib/ops-invariants-view.ts` holds the map, and its test checks it against every invariant id and every operation state.

**OPS-A.7, seller queues without MFA (V6, A1).** `/ops/publishers` and `/ops/payee-requests` render their queues read-only for an operator session without MFA. The MFA wall is in the reads, so these change:

- `domain/catalogue/src/payee.ts` `listOpenRequests`, `domain/catalogue/src/applicants.ts` `listApplicants`, `domain/catalogue/src/agreements.ts` `listAgreements` and `domain/publisher-console/src/exposure.ts` `publisherExposure` accept an operator without MFA. Every write function keeps its MFA check.
- `src/composition/ops-sellers.ts` (where UI0.7 moved `opsPublishers.list` and `opsApplicants.list`) drops its `mfa_required` return for the reads.
- Without MFA, a PayPal merchant id shows as `"…" + last 4`.
- No `/api/v1` route calls these functions; their only callers are the composition.
- Every action button still posts to a route that answers 403 `mfa_required` without MFA, and the button says "needs your authenticator code".

**Composition modules (S3).** Each page imports reads only from its tab's module, which wraps the upstream function (no copy):

- Home and alert pages: `ops-home.ts` (AL's reads live there).
- Order page and Problems page: `ops-money.ts`, wrapping TR1's timeline read in `ops-controls.ts`, AL's alert reads in `ops-home.ts`, and the new invariant and operation reads.
- Case pages: `ops-buyers.ts`, wrapping AL's case reads.
- Seller queues: `ops-sellers.ts`.

## Outputs (only these files)

New:

- pages `apps/web/src/app/ops/money/problems/page.tsx`, `ops/money/orders/[ref]/page.tsx`, `ops/alerts/page.tsx`, `ops/alerts/[id]/page.tsx`, `ops/buyers/page.tsx` (redirect), `ops/buyers/cases/page.tsx`, `ops/buyers/cases/[id]/page.tsx`
- `apps/web/src/ui/ops/{HealthLights,AlertList,AlertDetail,CaseCard}.tsx`, `apps/web/src/ui/shell/AlertBell.tsx`
- `apps/web/src/lib/{ops-health-view,ops-alerts-view,ops-cases-view,ops-invariants-view,ops-copy}.ts`
- the tests below

Changed:

- `apps/web/src/app/ops/page.tsx` (lights, needs-you), `apps/web/src/ui/shell/Shell.tsx` (bell in the operator shell)
- `apps/web/src/app/ops/publishers/page.tsx`, `ops/payee-requests/page.tsx` (read without MFA)
- `domain/catalogue/src/{payee,applicants,agreements}.ts`, `domain/publisher-console/src/exposure.ts` (read functions only)
- `domain/payments/src/invariants.ts` (additive `rows` field)
- composition modules `ops-home.ts`, `ops-money.ts`, `ops-buyers.ts`, `ops-sellers.ts` (read functions only)
- `apps/web/src/lib/shell-tabs.ts` (`ready: true` for Buyers)
- `apps/web/src/flow-a11y.state.test.ts` (adds the new pages)
- tests that assert the old MFA read wall, each moved from "read refused" to "read allowed, write still refused" in the same file (C6, A2):
  - `e2e/zd-ops-publishers.spec.ts:226`
  - `apps/web/src/ops-publishers.state.test.ts:85-87` and `:261`
  - `domain/catalogue/src/applicants.state.test.ts:146-148`
  - `domain/catalogue/src/agreements.state.test.ts:84`
  - `domain/catalogue/src/payee.adversarial.test.ts:96`

Unchanged and still green: the write-refusal cases `ops-publishers.adversarial.test.ts:63`, `ops-applicants.adversarial.test.ts:83`, `payee.adversarial.test.ts:31`. No API route or migration change.

## Acceptance tests (commit 1: tests only, run red)

| Item         | Test file                                                                                        | Command                                                                                                                                                                                                                                                                                                                                                     | Expected                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-A.1, A.2 | `apps/web/src/ops-home-view.state.test.ts`                                                       | `corepack pnpm vitest run apps/web/src/ops-home-view.state.test.ts`                                                                                                                                                                                                                                                                                         | Each row of the lights table gives its words: database down, maintenance, dry-run, switch off, blocked, switch read null, no pass, a pass 301 s old and one 299 s old. Needs-you rows and the bell counts equal AL's seed; each href is in `OPS_PAGES`; the bell is absent from the buyer and seller shell source                                                          |
| OPS-A.3      | `apps/web/src/ops-alerts-view.state.test.ts`, `apps/web/src/ops-alerts-page.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/ops-alerts-view.state.test.ts apps/web/src/ops-alerts-page.adversarial.test.ts`                                                                                                                                                                                                                                      | Filters and totals match AL; resolve offers only the closed reason codes. A buyer or seller session on the alert pages lands on sign-in. The fix link is a relative path accepted by `lib/next-path.ts`                                                                                                                                                                    |
| OPS-A.4      | `apps/web/src/ops-order-view.state.test.ts`, `apps/web/e2e/ops-order.spec.ts`                    | `corepack pnpm vitest run apps/web/src/ops-order-view.state.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e ops-order.spec.ts`                                                                                                                                                                                                                        | Without MFA the view has no buyer name, full provider id or `ip_hash` (deep scan); with MFA it has them. A two-unit order has two evidence buttons. The alert's link ends `#seq-<n>` of the entry whose source is that alert. e2e: one click from an alert opens the order page at that anchor                                                                             |
| OPS-A.5      | `apps/web/src/ops-cases-view.state.test.ts`, `apps/web/src/ops-cases-page.adversarial.test.ts`   | `corepack pnpm vitest run apps/web/src/ops-cases-view.state.test.ts apps/web/src/ops-cases-page.adversarial.test.ts`                                                                                                                                                                                                                                        | Queue ordered by `sla_due_at`; detail shows only the actions allowed in the case state; the refund action posts to AL's route with an idempotency key. A buyer or seller session on both case pages lands on sign-in; a no-MFA view has no buyer name, provider id or `ip_hash` (deep scan); `buyer_message` is plain text. `/ops/buyers` redirects to `/ops/buyers/cases` |
| OPS-A.6      | `apps/web/src/ops-invariants-view.state.test.ts`                                                 | `corepack pnpm vitest run apps/web/src/ops-invariants-view.state.test.ts`                                                                                                                                                                                                                                                                                   | Every invariant id INV1 to INV7 and every `OperationStateSchema` value maps to its Problems URL. With a seeded INV1 break, `?inv=INV1` lists exactly the broken unit's order; `?op=unknown` lists exactly the seeded unknown operations; `detail` and `ok` of every invariant are unchanged                                                                                |
| OPS-A.7      | `apps/web/src/ops-queues.adversarial.test.ts` plus the moved tests                               | `corepack pnpm vitest run apps/web/src/ops-queues.adversarial.test.ts apps/web/src/ops-publishers.state.test.ts domain/catalogue/src/applicants.state.test.ts domain/catalogue/src/agreements.state.test.ts domain/catalogue/src/payee.adversarial.test.ts apps/web/src/ops-publishers.adversarial.test.ts apps/web/src/ops-applicants.adversarial.test.ts` | A no-MFA operator reads both queues, with merchant ids as last 4 only; every POST from them without MFA answers 403 `mfa_required`; every write function refuses `mfa: false`; buyer and seller sessions still land on sign-in                                                                                                                                             |
| Journeys     | `apps/web/e2e/ops-journeys.spec.ts`                                                              | `corepack pnpm --filter @umsbx/web test:e2e ops-journeys.spec.ts`                                                                                                                                                                                                                                                                                           | J1 morning check, J2 alert to fix and J3 "paid but cannot open" finish within the click counts in the operator page source (J1 2, J2 3, J3 4)                                                                                                                                                                                                                              |
| a11y         | `apps/web/src/flow-a11y.state.test.ts`                                                           | `corepack pnpm vitest run apps/web/src/flow-a11y.state.test.ts`                                                                                                                                                                                                                                                                                             | The text-read check passes for each new page                                                                                                                                                                                                                                                                                                                               |

No L item, so no mutation target. C4 to C7 apply.

## Build notes (round 2, binding)

- N-A1: the additive `rows` field on invariant results changes no existing answer (callers filter on `!ok` today). The PR lists any moved test.
- N-A2: the relaxed domain reads still refuse every non-operator actor.

## Do not

Add or change an API route or migration; relax any write function's MFA check; move or change the kill switch, Start, Stop or gate panels; show identity on a non-MFA session beyond the V6 queues; draw the timeline verified mark (OPS-B owns it).

Branch: `feat/int-ops-a`. Commit: `feat(web): operator home, alerts, cases and order page (INT-OPS-A)`.
