# Gate report: MVP-D two publishers in one approval (offline gate, lane DP-6)

Format: nfr.md SOP section 22 (`docs/evidence/TEMPLATE-gate-report.md`). Offline only. No environment values,
no tokens, no raw ids. Simulation and fixtures prove the modelled cases only, not PayPal compatibility.

- Gate: MVP-D, offline part (the real part is `docs/owner/MVPD-OWNER-STEPS.md`)
- Date: 2026-10-29
- Commit: tests `86f651b`, rig and lint exemption `d8e47a3` on `feat/mvp-d-gate` (from `main` `8f6293e`); this report and the docs are on the next commit
- Author: Sonnet 5.5 builder (DP-6) Reviewer: Opus 5.5 high (gate review); Sakthi merges
- Evidence runs: the command outputs below; no other `docs/evidence` file belongs to this gate

## Verdict

- [ ] APPROVED FOR SANDBOX DEMO
- [x] APPROVED WITH CONDITIONS (the builder's proposal; the Opus gate review decides)
- [ ] NOT APPROVED

Every acceptance row of the MVP-D table that needs no PayPal passes offline through the app's own entry points. Exactly: the order and checkout steps go through the route handlers
(`POST /api/orders`, `POST /api/orders/[ref]/checkout`), as do the approval in D-04 and D-07 and the library
read; the approval in the other twins (`engine.requestApproval`) and the buyer's return
(`engine.payments.onBuyerReturn`) go through the engine facade; the job loop is the app's own (`startJobs`). Direct
database writes are setup only (marking a publisher unverified, adding a ledger row for the INV7 drift check,
flipping the kill switch, which the ops Stop button does in the app). The twins run over the approved sandbox
transport behind the real scoped gate and a real approval row, with a fake Wire that plays the dry-run order
model, and the whole D run opens no socket. No critical or high finding is open. The window itself is
not ready: it needs the owner's approval row (D-042) at his own terminal, two people following the owner steps
live, and the lane review. The real half of D-01 is an **owner window**; D-02 real is **not attempted** (D-042).
The conditions below close when their decision rows and lanes exist; none is a money-safety defect (each fails
closed).

### Conditions of the verdict (open items)

W1 to W4 are the builder's; C1 to C5 are the Opus gate review's (GATE APPROVED WITH CONDITIONS, merge yes). C1 and C2 cover the same ground as the builder's `ci` and W3 and are kept separate so each has its own tick.

| Id  | Condition                                                                                                                                                                           | Owner / lane         | State                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------- |
| W1  | The owner writes the approval decision row (fields as D-042 lists; the next free `D-0xx`), S merges it, V inserts the matching `outbound_approvals` row and runs `safety:resume`    | owner (V), S         | open                    |
| W2  | The real sitting follows `docs/owner/MVPD-OWNER-STEPS.md` with the webhook OFF and the sitting local (ASM-78); D-052 is expired and not extended (D-056)                            | owner, S             | open                    |
| W3  | Sakthi runs `gitleaks git --no-banner --redact` on the full history (the binary is not in this container)                                                                           | Sakthi               | open                    |
| W4  | Mutation checks on the four targets (`composite.ts`, `apply.ts`, `due.ts`, `ledger/sums.ts`) were not run here (D-048: optional, at most 20 minutes in total); the reviewer decides | Opus review / Sakthi | open                    |
| C1  | Sakthi runs `corepack pnpm run ci` to exit 0 on the merge commit after DP-5b merges. The cancelled run in this report is not a pass                                                 | Sakthi               | open                    |
| C2  | Sakthi runs `gitleaks git --no-banner --redact` on the full history                                                                                                                 | Sakthi               | open                    |
| C3  | `tests/mvp-d` is run again on `main` after DP-5b merges                                                                                                                             | Sakthi               | open                    |
| C4  | The documentation fixes of the gate review (this change)                                                                                                                            | DP-6                 | closed with this change |
| C5  | The owner writes the `D-0xx` row, Sakthi merges it, and the owner inserts the approval himself with `safety:approve`                                                                | owner (V), S         | open                    |

## Acceptance table (mvp-plan MVP-D, D-01 to D-07)

Status words: **PASS** (offline twin ran green), **OWNER WINDOW** (the real half needs the owner's sitting),
**NOT ATTEMPTED** (decided not to run it for real, D-042), **N/A** (with the reason).

| Id   | Name                     | Status                                       | Evidence (every title starts with the id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Owner window or reason                       |
| ---- | ------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| D-01 | two_captures             | PASS offline; real half **OWNER WINDOW**     | `tests/mvp-d/d01-d03-composite`: one approval snapshot with `settlement: 2 payments`, one order, two PayPal orders captured, two units on two publishers each with its own capture id and PayPal order, both `captured_verified`; two available entitlements (one per item) and two library entries that open; one sale per publisher equal to its price; one receipt with 2 items and 2 publishers; all 7 invariants hold. Nothing captured after only one approval. The 12 PayPal calls are counted: 1 token, 2 creates (one unit each, no `payee`, `invoice_id` ending `-p1` and `-p2`), 7 reads, 2 captures                                                                                                                     | `MVPD-OWNER-STEPS.md` Steps 4 and 5          |
| D-02 | partial_capture          | PASS offline; real **NOT ATTEMPTED** (D-042) | same file, both orders of the decline (PO2 declined, PO1 declined): `paid_partial`; captured item available, declined item `locked` and its unit `declined`; no ledger row for the declined unit; no refund request; item kinds `ready` and `declined`; one `partial_composite` alert (`reason: partial`, `not_charged: 1`); after two sweeps exactly one case `partial_composite`, `open`, on the order; INV1 to INV7 hold                                                                                                                                                                                                                                                                                                         | a real decline is not provoked at PayPal     |
| D-03 | no_substitution          | PASS offline                                 | same file: after the partial, 1.5 s of the app's own job loop, two more sweeps, an order view and a library fetch change nothing: orders 1, quotes 2, proposals 1, approvals 1; no further `create_order`; the fingerprint of orders, units, ledger, entitlements, quotes, proposals and approvals is identical                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                         |
| D-04 | unverified_payee_refused | PASS offline                                 | `tests/mvp-d/d04-d05-gates-match`: for each publisher without `payee_verified_at` the approval route answers 409 `publisher_unverified`, no approval, no order, zero Wire calls, money tables unchanged; the same pack is approved once verified; an approval granted and then the payee lost: `POST /api/orders` answers 409 `payee_unavailable`, zero orders, units, PayPal orders, entitlements and Wire calls                                                                                                                                                                                                                                                                                                                   | none                                         |
| D-05 | per_unit_match           | PASS offline                                 | same file: after the second capture the read shows another payee (and, in a second case, another amount on the first): that PayPal order is `frozen`, its unit `mismatch` with the reason, the order `paid_partial` with `mismatch = true`, one `frozen_order` alert, the held item is `hold` and locked, the other item `ready`, never "not charged", no `partial_composite`, one sale booked, INV1 to INV7 hold. Three pre-capture cases (payee or amount, PO1 or PO2): the whole order is `frozen`, both PayPal orders `frozen`, **0 captures sent**, 0 capture ids, 0 ledger rows, 0 available entitlements, one `frozen_order` alert with `phase: pre_capture`, every line `hold`; a later return and job pass capture nothing | a real mismatch cannot be provoked at PayPal |
| D-06 | ledger_per_publisher     | PASS offline                                 | `tests/mvp-d/d06-d07-ledger-currency`: per-publisher net (computed here with `publisherBalances`) equals each publisher's price after a happy pack; only the captured publisher has a balance after a partial (both orders of the decline); after a 10-minor partial refund of one unit and a full refund of the other the nets are price minus refund and 0; INV7 holds in each; an injected sale on the declined unit makes INV7 fail and name that publisher with `difference 77`                                                                                                                                                                                                                                                | none                                         |
| D-07 | mixed_currency           | PASS offline                                 | same file: USD plus GBP, in both orders and also with the GBP publisher verified: 422 `mixed_currency` ("different currencies"), no approval, no order, zero Wire calls, money tables unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                         |

Also covered (`tests/mvp-d/continuation`, `d-offline.adversarial`):

| Item                    | Status       | Evidence                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Continuation, in flight | PASS offline | `D-continuation`: the kill switch is pulled while the first capture is in flight (lease 1 s): `unresolved` and `approved`, then after resume the job loop reads PO1 as captured and captures PO2 once. Final: `paid`, one capture per PayPal order, 2 sales, 2 verified units, 2 library entries open, INV1 to INV7 hold                                     |
| Continuation, between   | PASS offline | `D-continuation`: the switch is pulled after PO1's read-back, before PO2's capture: `capture_requested` (never `awaiting_buyer`, polled on every check), 1 available item; after resume the loop captures PO2 once; same end state                                                                                                                           |
| Continuation, restart   | PASS offline | `D-continuation`: as above, the first app is closed and a second app opens the same on-disk database against the same PayPal side; one capture of each PayPal order across both processes; `paid`; INV hold. (A closed app and a reopened disk, not a SIGKILLed child: the single-order SIGKILL proof is C-11)                                               |
| No double capture       | PASS offline | `D-continuation`: once paid, three more returns and 1.5 s of job passes leave the same two captures and two sales                                                                                                                                                                                                                                            |
| Pack window             | PASS offline | `D-pack-window`: window 1.5 s, one approval, 1.8 s of silence, the job loop: both PayPal orders `abandoned`, order `abandoned`, 0 captures at the Wire, 0 capture ids, 0 ledger rows, 0 open entitlements, library opens nothing, item kinds `abandoned`; a later return changes nothing                                                                     |
| No socket               | PASS offline | `d-offline.adversarial`: the four D files (29 D tests) loaded under the interception of the C gate: zero `net.connect`, `Socket.connect`, `tls.connect`, `http(s).request`, `http2.connect`, dns (callback and promises), `fetch` and no client socket on `net.client.socket`; 44 tests in all with the 13 canary tests, the SOP 16 scan and the result test |
| SOP 16 (uploads)        | N/A          | no route of the web app takes an upload and content is seeded; a scan of the 18 route files (`D-offline SOP 16`) finds no `upload` name, no `formData()` and no multipart                                                                                                                                                                                    |
| A, B and C suites       | PASS         | `vitest run --project integration tests/mvp-a tests/mvp-b tests/mvp-c tests/mvp-d`: 21 files passed, 3 skipped (the owner-run `tests/mvp-c-pg` Postgres files, matched by the `tests/mvp-c` prefix), 203 tests passed, 10 skipped                                                                                                                            |

Counts (7 rows): **PASS offline 7** (D-01 to D-07); of those, **real half OWNER WINDOW 1** (D-01) and **real NOT ATTEMPTED 1** (D-02).

## Findings by severity

### Critical

none

### High

none

### Medium

none

### Low

#### F-1 The owner cannot list the debug ids of the sitting's PayPal calls

- Issue: `provider_calls` stores a debug id per call, but the database cannot be opened while the app runs and no owner command prints them. `safety:status` shows only the budget line.
- Risk: the evidence the owner brings back has no debug ids unless the PayPal dashboard offers them.
- Impact: evidence completeness only. No money or secret exposure.
- Fix: a small read-only listing command (a later lane), or accept "not available to the owner" (the owner steps already say so).
- Files: `docs/owner/MVPD-OWNER-STEPS.md` (What to bring back, item 2)
- Status: open

#### F-2 `payee_shared` can still be updated by an operator actor at the database role level (DP-1 review L2)

- Issue: the flag is set only by the audited DP-5 boot step, but the role set does not forbid an update.
- Risk: an operator could mark two publishers as sharing a payee without the audit row.
- Impact: P18 integrity. Fails toward doing less (a shared payee only matters when two publishers hold the same id, which the guard of migration 0010 checks).
- Fix: a later Supabase migration `REVOKE UPDATE (payee_shared) ON publishers FROM ums_app`. DP-6 changes no migration.
- Files: `packages/db/migrations/common/0010_publisher_payee_shared.sql`, `docs/ASSUMPTIONS.md` (Open items)
- Status: open

#### F-3 The mixed-currency refusal is guarded twice, and the second guard answers a different code

- Issue: with the `mixed_currency` check removed (negative control below), the approval is still refused, with `corridor_unsupported`. D-07 asserts `mixed_currency`, so it fails on that edit; a pack with a GBP item is never approved either way.
- Risk: none. Noted so a reviewer does not read the other code as a regression.
- Impact: none.
- Fix: none.
- Files: `domain/approval/src/approval.ts`
- Status: open (informational)

#### F-4 The pack-window and lease twins use real time

- Issue: `D-pack-window` uses a 1.5 s window and a 1.8 s sleep; the in-flight continuation uses a 1 s lease. The app has no injectable clock at the composition level.
- Risk: a very slow machine could take longer than 1.5 s between the first approval and the sleep; the outcome is the same (the pack is abandoned sooner), so the twin would still pass. A lease of 1 s on a loaded machine only delays the resolution.
- Impact: test time (the whole D integration set takes about 1.5 minutes, the adversarial run about 3 minutes) and a theoretical flake.
- Fix: none needed; an injected clock in the composition would remove the sleeps.
- Files: `tests/mvp-d/continuation.integration.test.ts`
- Status: open (informational)

## Control checklist (nfr.md section 1.3, MVP-D)

`[x]` offline proof; `[o]` needs the owner window; `[n]` not run here.

- [x] SOP 16 uploads: not applicable, no upload route (scan test)
- [x] P18 payee verification: D-04 (approval refused; lost between approval and order)
- [x] P5 re-run per unit: D-05 (post-capture hold per PayPal order; pre-capture whole-order freeze)
- [x] P11 per publisher: D-06 (INV7 after happy, partial and refunds; drift is named by publisher)
- [x] P4 one capture per PayPal order and P17 pack window: continuation twins and `D-pack-window`
- [x] REL-2 restart safety for a pack: `D-continuation` (kill switch, restart on the same disk)
- [o] D-01 real half: two sandbox captures into one test merchant account (owner steps)
- [n] D-02 real decline: not attempted (D-042)
- [n] mutation score on the four targets, gitleaks full history: see Machine checks

## Machine checks

All run in the worktree `sbx-wt-dp6` on `feat/mvp-d-gate` (Node 22.22.0, pnpm 10.34.7), offline, on a machine
shared with another builder.

| Check                                 | Command                                                                                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                                | `corepack pnpm format:check`                                                                                                          | exit 0                                                                                                                                                                                                                                                                                                                                                                                   |
| Lint                                  | `corepack pnpm lint`                                                                                                                  | exit 0 (max-warnings 0)                                                                                                                                                                                                                                                                                                                                                                  |
| Typecheck                             | `corepack pnpm typecheck`                                                                                                             | exit 0 (includes `tests/mvp-d`)                                                                                                                                                                                                                                                                                                                                                          |
| Isolation                             | `corepack pnpm check:isolation`                                                                                                       | ok                                                                                                                                                                                                                                                                                                                                                                                       |
| No live host                          | `corepack pnpm check:no-live-host`                                                                                                    | ok                                                                                                                                                                                                                                                                                                                                                                                       |
| Secret names                          | `corepack pnpm check:secrets-names`                                                                                                   | ok                                                                                                                                                                                                                                                                                                                                                                                       |
| Routes, provenance, fixtures, hosting | `check:routes`, `check:provenance`, `check:fixtures`, `check:hosting`                                                                 | ok (18 route files), ok, ok, ok                                                                                                                                                                                                                                                                                                                                                          |
| Lint rules test                       | `corepack pnpm exec vitest run scripts/lint-rules.test.ts`                                                                            | 330 passed (with the one new pinned exemption)                                                                                                                                                                                                                                                                                                                                           |
| Acceptance 1                          | `corepack pnpm vitest run --project integration tests/mvp-d`                                                                          | exit 0: 4 files, 29 passed; every title starts with `D-01` to `D-07`, `D-continuation` or `D-pack-window`; 1 m 33 s                                                                                                                                                                                                                                                                      |
| Acceptance 2                          | `corepack pnpm vitest run --project adversarial tests/mvp-d/d-offline.adversarial.test.ts`                                            | exit 0: 1 file, 44 passed (29 D tests, 13 canary and interception tests, the SOP 16 scan and the result test); zero socket, TLS, DNS or fetch calls; 3 m 13 s                                                                                                                                                                                                                            |
| Acceptance 3                          | `corepack pnpm exec vitest run --maxWorkers=2 --project integration tests/mvp-a tests/mvp-b tests/mvp-c tests/mvp-d`                  | exit 0: 21 files passed, 3 skipped (owner-run Postgres files), 203 passed, 10 skipped; 3 m 25 s                                                                                                                                                                                                                                                                                          |
| Acceptance 4                          | `corepack pnpm run ci`                                                                                                                | **cancelled at the 10 minute limit (D-048), not a pass**: install, format, lint and typecheck of all packages (including `tests/mvp-d`) ran green inside it; the all-suites `pnpm test` step did not finish in time and was stopped. The suites that matter here ran separately (Acceptance 1 to 3, lint-rules); the full six suites were not repeated. Sakthi or the reviewer runs `ci` |
| Mutation, 4 targets                   | `corepack pnpm mutation --targets domain/payments/src/composite.ts,...apply.ts,...due.ts,domain/ledger/src/sums.ts --require-targets` | **not run** (D-048: optional, at most 20 minutes in total; the lead said no mutation runs). Negative controls below show the twins can fail                                                                                                                                                                                                                                              |
| gitleaks full history                 | `gitleaks git --no-banner --redact`                                                                                                   | **not run**: the binary is not installed in this container. Sakthi runs it. The lane commits no key, token or secret value (the merchant id is a made-up 13-character value)                                                                                                                                                                                                             |
| Dependency audit (SUP-2)              | `corepack pnpm audit --prod`                                                                                                          | not run: needs the registry                                                                                                                                                                                                                                                                                                                                                              |

Disk before and after: 3.3 GB free before; 3.1 GB after (above the 800 MB stop line throughout).

## Red evidence (tests first) and negative controls

Commit 1 (`86f651b`) holds only the five test files. They import `./d-support`, which commit 2 adds, so they
were run red first:

```
corepack pnpm exec vitest run --maxWorkers=2 --project integration tests/mvp-d   (d-support.ts moved aside)
 FAIL  tests/mvp-d/{continuation,d01-d03-composite,d04-d05-gates-match,d06-d07-ledger-currency}.integration.test.ts
 Error: Cannot find module '/tests/mvp-d/d-support' imported from ...
 Failed Suites 4, 0 tests ran
```

That red is a missing module, not a behaviour. Because every product lane was already merged (no product code
changes in this lane), the twins were also made to fail by editing product code in the worktree, running the
matching twin, and reverting with `git checkout` (no product file is changed in any commit of this lane):

| Edit (reverted)                                                               | Twin that went red                                | Failure                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `approval.ts:185` the `mixed_currency` check made `if (false)`                | D-07 (3 tests)                                    | `expected 'corridor_unsupported' to be 'mixed_currency'` (see F-3)  |
| `composite.ts:220` the `partial_composite` alert condition `not_charged > 99` | D-02 (both orders of the decline)                 | `expected +0 to be 1` (no alert)                                    |
| `approval.ts:262` the P18 test `payee_verified_at === null` made `if (false)` | D-04 (3 tests)                                    | `expected 201 to be 409`                                            |
| `match.ts:92` the payee comparison made `if (false)`                          | D-05 (the post-capture and two pre-capture cases) | `expected 'paid' to be 'paid_partial'`; `expected true to be false` |

## Existing tests edited

One: `scripts/lint-rules.test.ts` gained the line `'tests/mvp-d/**/*.ts -> sbx/no-package-escape'` in the pinned
list of named exemptions (D-015), which the spec allows ("one `NAMED_EXEMPTIONS` entry with its pin"). No assertion
was changed. My own commit-1 test file `d04-d05-gates-match.integration.test.ts` was edited after commit 1 to fix
a TypeScript type error in an `it.each` table (found by `typecheck`); no assertion changed.

## Not tested, and assumptions

- Nothing here touched PayPal or any network. The fake Wire plays the dry-run order model, not PayPal: its capture, read-back and refund answers are synthetic. Whether PayPal accepts two creates with the payee left out, keeps an approved order capturable for the pack window (ASM-75, unverified) and reads the payee back as the owner's id for both is the owner window.
- The post-capture mismatch is played by changing the scenario of the read after that PayPal order's capture (the Wire passes the scenario to the model); it models "PayPal reports another payee or amount than we stored", not a real PayPal answer.
- The "crash" is a kill switch plus a closed app and a reopened on-disk database against the same model; a SIGKILLed process is proved for a single order only (C-11).
- D-01 real, D-02 real (not attempted), a real refund of a composite pack, the hosted webhook and a hosted run were not tested. A real refund is out of the planned sitting; the offline refund twin (D-06) runs with `refund_capture` and `get_refund` in the approval row, which the D-042 row for the sitting leaves out unless the owner adds them.
- Banner tone classes and the cancel page text are not asserted (DP-5b changes them). The twins assert stored item kinds and a pattern for "not charged".
- Mutation scores and gitleaks: see Machine checks and conditions W3 and W4.
- ASM-75 (how long PayPal keeps an approved, uncaptured sandbox order capturable) stays unverified; the pack window is 60 minutes and the owner steps finish in under 15.
- Positions of the PayPal orders follow the publisher ids, which are random per run; the twins find the publisher by stored data and never assume which one is first.
