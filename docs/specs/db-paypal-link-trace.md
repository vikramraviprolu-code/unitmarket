# db-paypal-link-trace: journal the publisher's PayPal address link

Task: Add `publisher_paypal_links` to the transaction journal (TR0), so every change of the address a publisher is paid to has an actor, channel, time and mfa flag.
Package: `packages/db` (migration 0031), `packages/contracts` (TRACKED_TABLES), `domain/trace` (words). Owner: Sonnet 5.5 builder (lane TR-LINK). Reviewer: Opus gate.

## Finding (what was missing)

`requestPaypalLink` and `decidePaypalLink` already write `audit_log` rows (masked address: first letter and domain), and `audit_log` is tracked. Not recorded today:

- A direct SQL change of `paypal_email`, `state`, `verified_by` or `verified_at` leaves no trace event: no actor, channel, time or mfa.
- The masked audit form cannot show that the address changed: `seller@x.com` and `sally@x.com` both mask to `s***@x.com`.
- `payouts` and `payout_items` are not tracked (migration 0029). `payouts.payee_merchant_id` holds the clear address at creation. Out of scope here; see the PR finding.

## Goal

After migration 0031 every insert or update of a `publisher_paypal_links` row writes one journal event on the chain `pub:<publisher_id>` in the same transaction. Copied: `state`, `verified_by`, `verified_at`. The address only as sha256 (`hashed`, never clear). Time column `updated_at`. A row that exists before the migration is backfilled once. No behaviour of `paypal-link.ts` changes.

## Inputs

`0023_trace_journal.sql`, `0026_api_exposure.sql` and `0027_rule_settings.sql` (the pattern), `0028_publisher_accounts.sql` (the table), `0025_alert_events.sql` (last `trace_subject`), `packages/contracts/src/trace.ts`, `domain/catalogue/src/paypal-link.ts`.

## Outputs

- `packages/db/migrations/common/0031_publisher_paypal_link_journal.sql`: `trace_tracked_seed_0031()`, `trace_tracked_reseed_0031()` with its AFTER TRUNCATE trigger, `trace_source_id` with one more branch (`publisher_id`), `trace_subject` with one more branch (`pub:` chain), trigger `trace_capture_publisher_paypal_links` (AFTER INSERT OR UPDATE), `SELECT trace_backfill()`.
- `packages/contracts/src/trace.ts`: one `TRACKED_TABLES` entry. `domain/trace/src/words.ts`: its two sentences.
- Tests: `packages/db/src/migration-0031-journal.state.test.ts`, `domain/catalogue/src/paypal-link-trace.state.test.ts`; the world in `trace-test-support.ts` gets a step; `trace.golden.test.ts` and `trace-pii.adversarial.test.ts` list the table.

## Acceptance tests

- `corepack pnpm exec vitest run domain/catalogue/src/paypal-link-trace.state.test.ts`: (1) a publisher's request gives an event with that publisher as actor and the hash, no clear address in any trace table; (2) a change gives a second event with another hash and state back to requested, verified_by and verified_at cleared; (3) an operator with mfa verifies: actor operator, mfa true, verified_by and verified_at copied; (4) a write with no context is `unattributed` and `verifyTrace` has no findings.
- `corepack pnpm exec vitest run packages/db/src/migration-0031-journal.state.test.ts`: seed convention, reset refill, backfill over a 0030 database, direct SQL attributed, export then import (restore) keeps the journal.
- `corepack pnpm exec vitest run packages/contracts/src/trace.golden.test.ts domain/trace/src/words.golden.test.ts`: 31 tables; seed rows equal the golden list; words for every event type.
- `corepack pnpm exec vitest run packages/db/src/trace-capture.state.test.ts packages/db/src/trace-backfill.state.test.ts packages/db/src/trace-restore.state.test.ts packages/db/src/trace-pii.adversarial.test.ts packages/db/src/trace-perf.state.test.ts packages/db/src/trace-verify.state.test.ts packages/db/src/migration-0027.state.test.ts`: unchanged tests still pass.
- `corepack pnpm lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:routes`, `check:secrets-names`: exit 0.

## Owner decision: the boot window of 0031

While 0031 is applied but the old application revision still serves traffic (the boot window of a deploy, or if migration 0032 refuses in the same boot), the old revision's operator Activity screen and the unfiltered `/api/ops/activity` throw `words: unmapped event type` (`wordsKeyOf` in `domain/trace/src/words.ts`, called from `activityPage`) as soon as a link event exists. The backfill writes one per link at once. Writes and the order, unit, buyer, seller and evidence views are unaffected. Same class as 0026 and 0027. Options:

- (a) A non-throwing fallback in a release before 0031. It conflicts with the deliberate fail-loudly design and needs two deploys.
- (b) Deploy 0031 alone, not in the same boot as 0032.
- (c) Accept the short window and record it in the decision log.

The coordinator recommends (c) for the single planned deploy: the window is minutes, only the operator Activity page is affected, and the 0032 pre-check returned 0 duplicates.

## Notes (low)

- The address hash is permanent personal data in an append-only journal that `scripts/lib/privacy.mjs` cannot pseudonymise. Decision-log note for the owner.
- A DELETE of a link row is not journaled and `trace_verify` does not detect it. This holds for every tracked table; no app path deletes link rows.
- `trace_backfill()` adds an `imported` event for any tracked row that lacks events (for example after importing a dump taken before a table was tracked), so 0031 is not strictly this table only. It is idempotent.
- Restoring a dump taken before 0031 leaves link rows with no event, and `trace_verify` reports drift. `SELECT trace_backfill();` repairs it.
- The backfill holds the trigger's SHARE ROW EXCLUSIVE lock on `publisher_paypal_links` and the `pub:<id>` head row locks until commit. Small at the current scale.

## Do not

Add `payouts` or `payout_items` to the journal; change `paypal-link.ts` or any contract other than the list; edit an existing test beyond listing the new table; add a dependency; apply the migration to any hosted database; call PayPal; touch secrets.

## Evidence for the PR

Red run of commit 1, green run of commit 2 (command output), the finding above, and the payout finding.

Branch: `feat/db-paypal-link-trace` Commit: `feat(db): journal publisher_paypal_links (TR-LINK)`
