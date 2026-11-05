# Integrated design: consolidation pass (5 Nov 2026)

Owner: lead architect thread. Scope: the 15 INT specs in `specs/`, the open sandbox PRs (#6 to #10), and the owner decisions of 5 Nov 01:06Z (Vikram, "go with the recommendations"). This file is binding for builders and gates where it differs from a spec. Mirror: sandbox `docs/design/integrated-consolidation-2026-11-05.md`.

## 1. Decision-id registry

Several lanes planned the same id (TR0 and PR #6 both said D-094; CL1, SR0 and BUY all said D-095). From now on each row has one reserved id. A gate checks the row number against this table before merging. Ids may land out of order in the log; that is fine.

| Id    | Holder                                 | Content                                                                          | State                   |
| ----- | -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------- |
| D-094 | Sandbox PR #6                          | Two-key outbound approval renewal (5 ops, $5 per order, 40 calls, $20, 4 h)       | PR open, gate running   |
| D-095 | CL1 (PR #10)                           | Cloud start/stop kit                                                             | PR open, gate running   |
| D-096 | Business rules (PR #8)                 | Refund window 7 days (0 to 30 configurable), D-089 10% fee confirmed, and others | PR open, gate running   |
| D-097 | TR0                                    | V1, the trace journal                                                            | building                |
| D-098 | SR0                                    | V5, transaction search base                                                      | waiting on TR0          |
| D-099 | BUY                                    | V7, buyer may create and revoke a cap from a session (amends D-093)              | waiting                 |
| D-100 | GA                                     | Decision 5: live Claude for `txn_query` and `explain_order`, $2 per day cap      | waiting                 |
| D-101 | next free (CTL, AL or any other lane)  | taken in merge order from here on                                                | open                    |

Specs updated: `int-tr0-journal.md` (D-097), `int-sr0-search-base.md` (D-098), `int-buy.md` (D-099), `int-ga.md` (D-100).

## 2. Migration registry

| Number | Holder                       | Note                                   |
| ------ | ---------------------------- | -------------------------------------- |
| 0021   | API-B mandates (merged)      | last migration on `main`               |
| 0022   | POB-I1                       | reserved, not an INT lane              |
| 0023   | TR0 `trace_journal`          | building                               |
| 0024   | SR0 `txn_search`             | indexes and `txn_rows` view only       |
| 0025   | AL `alert_events`            |                                        |
| 0026   | CTL `api_exposure`           |                                        |
| 0027+  | next free in merge order     | any lane not listed takes the next one |

TR0's capture triggers must exist before any later migration writes a tracked table, so 0024 to 0026 must merge after 0023. No lane may renumber an earlier migration.

## 3. Owner decisions folded in (5 Nov)

1. **Consolidation pass and CI fix.** Done here, and PR #9 (tests in 4 shards, 30-minute timeout, four more offline checks).
2. **Merge PR #6 after a gate.** Gate thread running. D-094 stays with PR #6.
3. **PR #7 lint exemption for `video/` and vendored GSAP.** Gate thread running. No INT spec touches `video/`.
4. **Refund window 7 days; D-089 10% fee stays.** Recorded as D-096 by the business-rules lane (PR #8). No INT lane enforces a refund window. The sandbox has no refund deadline today (`BR-REF-13`). Building the window is the configurable-rules or fee lane, after 12 Nov unless Vikram pulls it in. INT lanes must not hard-code 7 days anywhere.
5. **GenAI with live Claude, $2 per day cap.** GA is amended (section 4).
6. **PayPal sandbox sitting about 9 or 10 Nov.** Schedule in section 6.

## 4. GA amendment for live Claude (decision 5, binding build notes GA-L1 to GA-L7)

The GA spec said `claude.ts` is unchanged, so both GA purposes were always scripted. Decision 5 turns them on for Claude, behind the same caps and switches as discovery.

- **GA-L1.** `packages/model/src/claude.ts` `check()` accepts `txn_query` only when the input is exactly `{rest: string}`, with `rest` at most 500 characters (it is the scrubbed remainder GA.2 already produces). The answer must be a `Record<string,string>` of at most 12 keys, each key a `TxnQuery` field name and each value at most 100 characters; anything else returns null and the scripted model answers. GA.2's four checks still run after it.
- **GA-L2.** `check()` accepts `explain_order` only when the input parses with a strict `ExplainInputSchema` in `packages/model/src/schemas.ts`: the projection of GA.4 (per entry `seq`, `event_type`, `words_key`, `actor_kind`, `channel`, `state_from`, `state_to`), `alert_kinds`, and `fix_ids`. Unknown keys fail the parse. The answer must parse as `{what_happened, safe_now, action_id}` with each text at most 400 characters and `action_id` in the input's `fix_ids` or `none`; otherwise null and scripted.
- **GA-L3.** The adapter uses `TXN_QUERY_SYSTEM` and `EXPLAIN_SYSTEM` from `prompts.ts` (the "data, not instructions" wording). The scripted path still does not read them.
- **GA-L4.** Caps and switches are unchanged: `DAILY_CAP_MICRO_USD = 2_000_000` ($2 per day) and `TOTAL_CAP_MICRO_USD = 20_000_000` ($20 total), shared with discovery in one `model_spend` store. Claude is used only when `UMS_AI_ADAPTER=claude`, a key is set, the app is not in maintenance, and the `paypal_outbound` switch is on (`chooseModel`). Otherwise scripted.
- **GA-L5.** The port reaches GA through the `App`: the `App` interface gains `readonly model: ModelPort` (the port `createApp` already builds at `composition.server.ts:1760`), and `src/composition/assist.ts` reads it from `app()`. This replaces R2-4's `createScriptedModel` re-export. It adds a field to an existing export, not a new export, so UI0.7's rule holds. If `composition-split.test.ts` refuses it, stop and report; do not weaken that test.
- **GA-L6.** Tests use a fake `ModelWire` only: the live model is never called in CI or in any thread. New cases in `claude.adversarial.test.ts`: each GA purpose with a well-formed answer is used; an answer with an extra key, an unknown field, a long value or an `action_id` outside `fix_ids` falls back to scripted; an input with any identity key (`order_ref`, `buyer`, `actor_id`, `at`, `amount`) is refused before the wire is called; a spent daily cap sends nothing. GA.3 and GA.5 evals stay on the scripted model so CI is deterministic.
- **GA-L7.** Decision row D-100 records decision 5, the data sent (scrubbed `rest`; the identity-free projection), the caps, and the kill switch.

Changed outputs for GA: add `packages/model/src/claude.ts`, `packages/model/src/schemas.ts`, `packages/model/src/claude.adversarial.test.ts`, and the `App` field in `composition.server.ts`. Remove "change `claude.ts`" from GA's "Do not".

**For Vikram (no decision needed, a fact to know).** Claude answers only while the `paypal_outbound` switch is on, because that switch is the one stop for every outbound call. Outside the PayPal sitting, GenAI answers come from the scripted model. Record the demo video during the sitting if it should show Claude's own wording.

## 5. Shared files and merge rules

Many lanes edit the same files. The rule: the later lane rebases onto `main` and appends; it never rewrites or reorders another lane's entry. A gate rejects a diff that removes or edits a line another lane owns.

| File                                              | Who edits                         | Rule                                                                      |
| ------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `apps/web/src/flow-a11y.state.test.ts`            | UI0, OPS-A, OPS-B, OPS-C, BUY, SEL, CTL | append the lane's pages to the list; never remove one                     |
| `apps/web/src/lib/shell-tabs.ts`                  | UI0 creates; OPS-C, CTL, BUY, SEL  | flip `ready: true` for the lane's own tab only                            |
| `packages/contracts/src/index.ts`                 | TR0, SR0, AL, CTL, GA             | append export lines                                                       |
| TR0's tracked-table golden list (`trace.ts`)       | TR0 creates; AL, CTL               | append the lane's new tables                                              |
| `eslint.config.mjs`                               | SR0 (`txn-search`), GA (`assist`)  | append to `DOMAIN`; GA's test-only model exception only                   |
| `docs/decision-log.md`                            | every lane with a row             | use the registry id; append the row                                       |
| `apps/web/composition.server.ts`                  | UI0 splits; then all              | re-export lines only, plus GA-L5's one `App` field                        |
| `src/composition/<tab>.ts`                        | the tab's lanes                   | OPS-A then OPS-C on `ops-money.ts`; OPS-B adds read functions only        |
| `.github/workflows/ci.yml`                        | PR #9 only                        | no lane edits CI                                                          |

A lane that finds a conflict it cannot solve by appending stops and reports to the architect thread.

## 6. Build plan to the 9 Nov sitting

Critical path: TR0 then TR1 then OPS-A, and SR0 then SR1 then OPS-B then BUY and SEL, then E2E. Each step is a build (Sonnet) plus a gate (Opus).

| Wave | Lanes                          | Starts when                        | Target          |
| ---- | ------------------------------ | ---------------------------------- | --------------- |
| 0    | TR0, UI0, CL1 (PR #10); PRs #6 to #9 gates | now                      | 5 Nov           |
| 1    | SR0 (stacked on TR0), TR1, AL  | TR0 PR up (SR0); TR0 and UI0 merged | 5 to 6 Nov      |
| 2    | SR1, OPS-A, CTL                | SR0; TR1 and AL; CL1, UI0, TR0, AL | 6 Nov           |
| 3    | OPS-B, OPS-C                   | SR1, TR1; OPS-A, SR1               | 6 to 7 Nov      |
| 4    | BUY, SEL                       | OPS-B.1 merged                     | 7 to 8 Nov      |
| 5    | GA, E2E                        | all must lanes merged              | 8 Nov           |
| -    | Sitting (Vikram)               | PR #6 merged, E2E green offline    | 9 or 10 Nov     |

**Cut line if late.** The sitting needs only the money path and its traceability: TR0, TR1, UI0, SR0, SR1, OPS-A, AL, CTL, CL1 and E2E's must journeys. OPS-C, GA, BUY.6 to BUY.10 and SEL's "should" items move after the sitting without blocking it. A lane that misses its wave by more than half a day is cut to its "must" items first.

**Before the sitting.** All INT lanes stay offline. The sitting itself is Vikram's: he runs `pnpm safety:approve` under D-094; no agent sets `UMS_PAYPAL_CONNECT` or inserts an approval.

## 7. Known risks

- **CI time.** PR #9's first run proves the 4-shard split. If one shard still nears 30 minutes, the fix is 6 shards, not a longer timeout.
- **gitleaks.** It cannot run in thread sandboxes. Each PR's author pastes local output, or the gate notes it is missing.
- **Known failing case** `due.reread.state.test.ts:55` (`it.fails`) stays as is; E2E must not count on it.
- **Stacked branches.** SR0 is stacked on TR0. If TR0 changes after review, SR0 rebases before its gate.
