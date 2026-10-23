# UnitMarket: build status report for the briefing team

Status date: 23 Oct 2026. Prepared by the coordinating assistant at the owner's request, as source material for the briefing, the video and other write-ups. Every number says where it comes from. Where a number is reported by a builder and not re-measured by the coordinator, it says so. Simulation and offline tests prove the modelled cases only. They do not prove PayPal compatibility.

## 1. The short version

- UnitMarket lets people buy just the content they need, instead of paying for a whole subscription. A buyer asks for something, an agent proposes a pack of articles, the buyer approves once, and PayPal takes the payment.
- Two tracks were built. A simulation (19 to 20 Oct) proves the whole marketplace on one machine with no PayPal at all. A sandbox track (21 Oct onward) rebuilds the money path as production-grade code that talks to the real PayPal sandbox.
- MVP-A, the offline walking skeleton, passed its gate on 22 Oct. MVP-B, the first real PayPal sandbox run, started on 23 Oct.
- On 23 Oct the first real contact with the PayPal sandbox worked: the owner ran a read-only check from his own laptop. PayPal accepted the credentials (HTTP 200) and answered the lookup of an order that does not exist with the expected 404.
- No real order, capture or refund has been made yet. The first real purchase is the next milestone and waits on the last MVP-B lane (BU-6, the owner-run suite) and the owner's own approval step.

## 2. Timeline

| Date (2026)  | Milestone                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18 Oct       | Build Bible becomes the single planning document                                                                                                                                             |
| 19 Oct       | Simulation track starts: scaffold, import rules, payment port, contracts                                                                                                                     |
| 20 Oct       | Simulation complete: web app, scenario matrix, adversarial suite, mutation checks, 90-day history, browser journeys                                                                          |
| 21 Oct       | Sandbox repository created, separate from the simulation (D-001). Design baseline, corridors order, dependency list, no-connection rule decided                                              |
| 22 Oct       | MVP-A gate passed: 1,851 tests, 15 of 15 browser journeys. Payments second pass, gate fixes, seal hardening rounds                                                                           |
| 22 to 23 Oct | Seal hardening (five rounds), BU-1 production wire, webhook verify and intake, complete refunds, hosting config, single-opener lock, backup and restore                                      |
| 23 Oct       | MVP-B: unseal wiring (BU-2) and own-payee fix (BU-7) merged, `next start` proof (BU-3) merged. First real sandbox contact (spike Part R). Receiving preference set to keep original currency |

## 3. What the product does

1. A buyer arrives by one of two paths: a publisher's article-specific offer, or an agent-led conversation about their need and budget.
2. The agent proposes a pack of 1 to 5 items within the buyer's all-in ceiling. If nothing fits, the answer is an immediate, scoped "no match". Nothing is substituted or bought automatically.
3. The buyer approves once. The approval freezes the offer, version, payee, fees, total, currency and rights. It is valid for 15 minutes.
4. The order is written before any charge. PayPal takes the payment.
5. Access opens only after a verified captured payment and a separate read-back that matches amount, currency and payee.
6. The buyer gets five days to retrieve and keep a copy, or five days of online reading. If delivery fails, the lost time is restored and the buyer is never charged for a retry. The purchase history stays after the links expire.
7. Receipts, a ledger that cannot be edited, refunds and a recovery queue back the whole flow.

## 4. Simulation track (finished, kept for regression)

Source: the Build Bible's "Simulation: architecture, design, development" tab and the simulation repository at `main` 300ff02.

| Measure           | Result                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope             | Full marketplace in one folder: simulated PayPal, publishers, buyers, environment clock and faults, an independent oracle with six invariants, a static report, a 90-day generated history |
| Scenario matrix   | 80 of 80 pass, byte-identical on two runs. 57 catalogue scenarios with golden traces                                                                                                       |
| Adversarial suite | 14 files, 550 tests, all pass (baseline was 4 files, 30 tests)                                                                                                                             |
| Mutation checks   | 21 planted defects, 21 caught                                                                                                                                                              |
| Browser journeys  | 18 of 18 pass                                                                                                                                                                              |
| Web app           | 79 routes in the simulated build, 34 in the product build, 0 failed                                                                                                                        |
| Generated history | Default size: 60 publishers, 320 readers, about 1,200 orders, built through the real engine                                                                                                |
| Specs             | 22 simulation specs, two assumption registers, a porting guide for the sandbox                                                                                                             |
| Process           | 38-lane master plan in four waves, about 8 builders in parallel, Opus review on the high-risk lanes                                                                                        |

What it proves: the modelled cases only. The sandbox track exists because a simulation cannot prove PayPal compatibility.

## 5. Sandbox track: design

All numbers measured from the repository on 23 Oct (`main` 599cf4d plus later notes).

| Measure              | Result                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design documents     | 7 (architecture, MVP plan, non-functional requirements, hosting, unseal and MVP-C plan, README, lane index)                                                                                                               |
| Per-lane designs     | 22 lane design files, from scaffold to the MVP-A integration gate                                                                                                                                                         |
| Lane specs           | 20 task specs under `docs/specs`, each with acceptance tests as commands                                                                                                                                                  |
| Decision log         | 33 recorded decisions (D-001 to D-034; D-032 is held on the owner's laptop)                                                                                                                                               |
| Assumptions register | 51 numbered assumptions, each with a reason, what it touches, what happens if it changes, and a status                                                                                                                    |
| Evidence files       | 5 (two gate reports, templates, the spike Part R result)                                                                                                                                                                  |
| MVP plan             | Six stages: A offline skeleton, B real sandbox with one publisher, C hosted with webhooks and refunds, D two publishers, E WordPress, F hardening and submission. 27 acceptance checks for A, 13 for B, 13 for C, 7 for D |

### Architecture in one paragraph

A TypeScript monorepo (Node 22.22.0, pnpm 10.34.7) with 12 packages and 13 domain modules behind strict import rules enforced by lint. The domain code (catalogue, offer entry, discovery and fit, approval, payments, entitlements, access clock, ledger, receipts, delivery, recovery, library) imports only contracts and sibling domains. Only the transport package may touch the network. Only configuration reads environment variables. Time, ids and randomness are injected, so every run is repeatable. The database is PGlite (an in-process Postgres) with row-level security written for Supabase, with 9 migrations. The web app is Next.js 15.

### The five locks before any PayPal call

1. **Sealed transport.** The only object that can send to PayPal is created once, inside the safety package, and refuses to exist without a unique production-wire token.
2. **One fixed sandbox host.** One constant names the sandbox API host. No live host appears in code, fixtures or configuration, and a check fails the build if one does. Boot refuses any value naming live or production.
3. **Two-key approval.** An outbound call needs the connect flag on and an active approval row that only the owner can insert, at his own terminal, with a scope, an amount cap and a call budget.
4. **Kill switch.** One switch stops every outbound call within seconds, from the operations page or the command line. A missing switch row reads as off.
5. **Egress allow-list.** Wrong host, scheme, port, redirect or path is refused before sending.

### Money rules built into the code

- Expected transaction written before the charge. One capture per order. Same `PayPal-Request-Id` for any repeat.
- Access only after a verified COMPLETED capture and a separate matching read-back. PENDING never unlocks. A mismatch freezes the order.
- A webhook is only a hint. It never marks anything paid.
- Refunds are checked against what PayPal still holds. The ledger is append-only. One lock order for every money transaction, pinned by a test that spies on the statements.
- A 15-minute approval window is separate from a 24-hour payment-abandonment window.

## 6. Sandbox track: build and test

| Measure                                | Result                                                                                                                                                                                                        | Source            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Commits on main                        | 441 (82 merges) between 21 and 23 Oct                                                                                                                                                                         | git, measured     |
| Source size                            | 573 TypeScript and script files, about 103,000 lines                                                                                                                                                          | git, measured     |
| Test files                             | 274 in the repository: 127 unit, 63 state, 14 contract, 25 integration, 36 adversarial, 7 golden, 2 property, plus 3 end-to-end specs                                                                         | git, measured     |
| Tests at the MVP-A gate (22 Oct)       | 1,851 passed, 0 failed, 15 skipped (owner-only sandbox contract), 165 test files, 15 of 15 browser journeys                                                                                                   | gate report       |
| Tests in the latest full runs (23 Oct) | about 3,800 passed (3,795 to 3,817 depending on the branch), 15 skipped, 1 expected failure, in about 241 to 244 files. The only failures were timeouts under machine load, and each passed when re-run alone | builders' reports |
| Test methodology                       | Every module test-first: the tests are committed alone and run red before any code. Unit, state, contract, integration, adversarial, golden and end-to-end tests as the module needs                          | repo rules        |

### Mutation testing (do the tests actually catch bugs)

Mutants are small deliberate bugs planted in the code. A good test suite kills them. Scores below are reported by the builders per lane, on sampled mutants.

| Lane or file                                           | Killed                        |
| ------------------------------------------------------ | ----------------------------- |
| Webhook cert budget (CO-1c)                            | 98 of 100                     |
| Webhook signature verify (CO-1b series)                | 115 of 117                    |
| Webhook intake (CO-2c)                                 | 68 of 73                      |
| Refunds (CO-4)                                         | 67 of 80                      |
| Single-opener lock (CO-9)                              | 43 of 44                      |
| Backup and restore (CO-10)                             | 10 of 10 (after fixes)        |
| Unseal wiring, outbound builder and resume (BU-2)      | 29 of 30 and 21 of 22         |
| `next start` proof verdict rules (BU-3)                | 30 of 30                      |
| Owner-run suite subject, runner, secrets helper (BU-6) | 29 of 30, 30 of 30, 27 of 30  |
| Due-pass fix (BU-5b)                                   | 7 of 7 (hand-written mutants) |

Survivors are listed in each report and are almost all equivalent mutants (changes that do not alter behaviour).

### Review process

- Roles: Sonnet 5.5 builds, Opus 5.5 reviews, the owner approves. Nobody merges their own work. Money and safety lanes run on high effort.
- Each lane gets a spec, a red test run, an implementation, and at least one independent Opus review before merge. Findings are fixed and re-checked. Many reviews ran more than one round (the seal alone took five).
- Every merge is checked by lint with zero warnings, typecheck, format, and checks for live hosts, secret names, route inventory, isolation from the simulation, provenance of copied files, and fixtures. gitleaks scans every commit.

### Examples of what the reviews caught (good story material)

- A shared fetch budget that a dead webhook certificate could use up, starving a live one (fixed with a budget per URL).
- A reversal webhook that would have opened a recovery case on its own (now an ops-only hint).
- The create-order body always carried a payee that the first-stage scope refuses, so the app could not create an order. Found by the unseal review, fixed by option (c).
- The test runner adds flags that the transport guard refuses, so the owner-run suite and the approval commands would have failed in sandbox mode. Fixed with a plain-Node entry.
- A refund booking that took locks in the wrong order (a deadlock risk). Fixed and pinned by a test.
- Cloud environment: the review of credential handling found that the cloud machine intercepts HTTPS, so the first credentialed calls were moved to the owner's own laptop.

## 7. MVP-B progress

MVP-B is the first run against the real PayPal sandbox: one publisher, polling only (no webhooks).

| MVP-B lane                                                                       | State                        |
| -------------------------------------------------------------------------------- | ---------------------------- |
| BU-1, BU-1b production HTTPS wire, certificate pinning and self-check            | merged                       |
| BU-4, BU-5, BU-5b call budget and due-pass fixes                                 | merged                       |
| BU-2 unseal wiring (the only place the sealed transport is connected to the app) | merged after two Opus rounds |
| BU-7 own-payee omission (option c)                                               | merged after review          |
| BU-3 `next start` proof                                                          | merged after review          |
| BU-6 owner-run suite and plain-Node launchers                                    | built, in review             |

### First real sandbox contact (spike Part R, 23 Oct)

- Run by the owner on his own laptop, read-only, guided one command at a time. Three calls in total: one rejected at the token step because the secret was cut off when pasted (HTTP 401, nothing created), then the token request (HTTP 200) and a lookup of an order that does not exist (HTTP 404, the expected answer).
- Findings: both German sandbox accounts hold EUR only. The Business account's receiving preference was changed by the owner from "convert everything to EUR" to "accept without converting", which matches the new multi-currency requirement. The app carries a payouts permission that the product never uses.
- Not yet proven: a USD capture into that account, the PayPal webhook, and everything that needs a real order.

### What happens next in MVP-B

1. BU-6 review and merge, then the laptop is set up (Node 22.22.0 and dependencies already installed).
2. The owner creates the approval row and resumes the switch at his own terminal.
3. Payee check: a GET of the created order must show PayPal echoing our own merchant id, or the run stops.
4. One real purchase (B-01, B-08, B-09), a kill switch in the middle (B-06), then the conformance run (B-02, B-03, B-04, B-07).
5. Redacted recordings are promoted to fixtures (B-13).

## 8. Requirements audit (23 Oct)

A read-only audit mapped the 20 agreed requirements and the payment acceptance checks to the code.

- Implemented: five-day access and the access clock, the snapshot and the 15-minute approval, payment truth and read-back, simulator and sandbox separation.
- Partly built: the account and library, buyer-fit ranking (ranking exists, the visual dashboard does not), publisher agreements, commission split, onboarding, composite purchases, support operations, privacy controls.
- Not evidenced: publisher price ranges and renegotiation, cross-border disclosure text.
- Three conflicts for the owner: nine India, US and UK pairs versus the decision that India stays configuration only, the 48-hour library window in the simulation versus five days in the sandbox, and lost-time credit being impossible after the window has expired.
- Reading: the gaps are mostly "not built yet", not "built wrongly". Nothing found blocks the first real order.

## 9. Newly captured requirement: multi-currency holding

UnitMarket keeps receipts in their original currency (EUR, GBP and USD balances), converts only by a deliberate owner action, one currency per order, commission in the order currency if PayPal allows it, reports per currency. Recorded as D-030 and ASM-74. Not scheduled until the happy path is done. Open questions: whether the platform fee can be held in a currency other than the order currency, and the UnitMarket account's capability settings.

## 10. Open decisions and risks

Owner decisions pending: waive or run the real-Postgres race tests (ASM-55), confirm the seal freeze (ASM-70), multi-article refund limit (ASM-61), capture reserve floor (ASM-68), the three requirement conflicts above, hosting account and disk, WordPress host and brand, the Payouts permission on the app.

Risks stated plainly:

- No real PayPal order has run. Everything about real capture, real settlement and real webhooks is still unverified.
- A USD capture into a Business account that held only EUR is unverified until the first order.
- Real-Postgres concurrency has not been tested: the local database serialises statements, so deadlocks cannot show up there.
- The cloud build machine intercepts HTTPS, so credentialed work runs on the owner's laptop. Credentials briefly sat in the cloud machine's environment variables and are being removed and rotated.
- Hosted webhooks need a hosted address, which waits on the hosting decision.

## 11. Dates

- Submission target: Mon 9 Nov 2026. Official deadline: Thu 12 Nov 2026, 12:00 PT. The final entry must use the PayPal sandbox.
- Stages after MVP-B: C hosted with webhooks and refunds (about half built offline already), D two publishers, E WordPress (first to cut if time runs short), F hardening and submission.

## 12. Suggested beats for a video

1. The problem: pay for the article you need, not a whole subscription.
2. The loop in one minute: ask, propose, approve once, pay, read-back, access.
3. Two tracks: a simulation that proved the idea in two days, then the production-grade rebuild.
4. The safety story: five locks, one owner key, a kill switch, nothing connects without written approval.
5. The test story: test-first on every module, about 3,800 tests, mutation checks, an independent reviewer on every lane.
6. The honest status: first real sandbox contact worked on 23 Oct; first real purchase next.
7. The multi-currency and marketplace ideas that come after the happy path.

## 13. Where the numbers come from

- Repository facts (commits, files, lines, test files, decisions, assumptions, migrations): measured from `main` on 23 Oct.
- Test totals: the gate report `docs/evidence/mvp-a-gate-2026-10-22-final.md` and the builders' final reports.
- Mutation scores: the builders' reports, not re-run by the coordinator.
- Simulation figures: the Build Bible simulation tab and `docs/specs/sim/loop3-results.md` in the simulation repository.
- Real sandbox contact: `docs/evidence/spike-part-r-2026-10-23.md` and decision D-034.
- The repository holds 274 test files while the full run reports about 244. The difference is suites that run separately or opt in, such as the `next start` proof. This split was not individually verified.
- No credential, token, account id or email appears in this report.
