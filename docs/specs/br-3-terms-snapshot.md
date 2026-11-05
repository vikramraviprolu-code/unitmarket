# Spec: resolved terms frozen into the approval (BR-3, UNI-80)

Task: every new approval carries the business terms that apply to it, inside the content hash, and the access window follows them.
Package: `packages/contracts` (`src/approval.ts`), `domain/approval`, `apps/web` (composition, approvals route, buyer copy)
Owner: builder (Sonnet) Reviewer: Opus (L) Branch: `feat/rules-terms-snapshot`
Commit: `feat(approval): freeze resolved terms in the snapshot (BR-3)` Depends on: BR-1, BR-2. Decision: D-096 (5) new sales only.

Goal: terms are resolved inside `requestApproval` and frozen into the snapshot. A later rule change never alters a stored snapshot.
Tampering with stored terms fails `verifyApproval` with `snapshot_tampered`. (A price change between quote and approval stays the
job of the existing price check, BR-APR-6, `approval.ts:221-241`; a rule added in that gap is simply included.) Every new approval
has terms, so no new sale escapes the BR-4 deadline. With no override rows the only visible change is D-096: access becomes 7 days.

Design:

- `ApprovalSnapshotSchema` becomes a union on `snapshot_version`: `'1'` (today's shape, no `terms`, for stored rows) and `'2'`
  (same fields plus required `terms: { rules_version: '1', values: { 'refund.request_window', 'access.window', 'mandate.max_days' },
sources, digest }`, strict, each value inside its registry range). `requestApproval` writes only version `'2'`.
- `domain/approval/src/approval.ts`: after the items are built and before `contentHash`, call `resolveTerms` (BR-1) with `activeRows`
  (BR-2) for each publisher and the buyer. With two publishers, resolve once per publisher and merge the two results per key by that
  key's strategy (refund `max`, access `seller_wins` taken as `max` across sellers, mandate `min`); the link rule runs again after.
  Refuse with `terms_invalid` (new code in `domain/approval/src/errors.ts`) if the resolver errors; `apps/web/src/app/api/approvals/route.ts`
  maps it to 422 with reader-safe text.
- Each item's `policy.window_ms` becomes `values['access.window'] * 86_400_000` when that is longer (never shorter). The raised policy
  keeps its `id` and gets `version: '<original version>+rules'`, so the entitlement's stored policy (written by
  `createPendingEntitlements`) does not claim to be the 5-day policy. `AccessPolicySchema` (`version: z.string().min(1)`) parses it.
- The access clock is unchanged: it reads `policy.window_ms`. Buyer copy that hard-codes "5 days" (`apps/web/src/lib/format.ts:18-19`,
  `apps/web/src/lib/buyer-copy.ts:86`) reads the window from the entitlement instead (conflict C8).
- POB-M1 payout ("due when the access window has ended and no refund is open") follows D-096 unchanged: access is never shorter than refund.
- Golden and fixture files that pin a content hash or "5 days" change. List each in the PR with the reason; edit no other test.

Files: `packages/contracts/src/approval.ts` and test; `domain/approval/src/approval.ts`, `errors.ts`, `snapshot.ts` if it builds the
object, new tests; `domain/approval/package.json` and `pnpm-lock.yaml` (dependency on `@umsbx/rules`); `apps/web/composition.server.ts`;
`apps/web/src/app/api/approvals/route.ts`; `apps/web/src/lib/format.ts`, `buyer-copy.ts`; the listed golden files.

Tests first: `packages/contracts/src/approval.test.ts` (version 2 requires strict terms; version 1 parses without; version 1 with
terms refused); `domain/approval/src/terms.state.test.ts` (no rows: refund 7, access 7, item `window_ms` 604800000, policy version
ends `+rules`; seller row 14 raises both; a platform row added after approval: `verifyApproval` still ok and stored terms unchanged;
two-publisher order merges per key strategy); `domain/approval/src/terms.adversarial.test.ts` (a version 2 snapshot without terms is
refused at parse and at verify; a terms value outside its safe range refused at parse; stored snapshot with edited `terms.values` or
`terms.digest` fails with `snapshot_tampered`); a pin test that the same inputs hash to the same digest across two runs;
`domain/access-clock` tests stay green.

Acceptance: those tests plus the six suites pass, red run first; `corepack pnpm mutation --targets domain/approval/src/approval.ts
--require-targets` kills at least 80 percent; `check:fixtures`, `check:openapi`, `check:no-live-host`, `check:secrets-names`, lint,
typecheck, format pass.
Do not: touch payments, refunds or the ledger; change `APPROVAL_TTL_MS`; change the access-clock package; add a dependency.
Evidence: red and green runs; one snapshot JSON before and after (ids sanitised); the list of changed golden files.
