# MVP-A construction lanes: wave plan, interfaces, verification

Baseline: `architecture.md`, `mvp-plan.md`, `nfr.md`, all BASELINE v1.0 (21 Oct 2026). Repository: `/home/user/unitmarket-sandbox` (D-1; local git, no remote). Copy-and-adapt source: `/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`, read only, never imported. MVP-A is offline: no lane connects to PayPal, uses an account or reads a credential (D-9).

Every lane follows the SBX spec protocol (copied into the SBX `CLAUDE.md` by lane 00): one spec, one worker session, one branch, one PR, one review. Workers: Sonnet 5.5 medium. Reviewers: Opus 5.5 medium, independent of the author. A lane's acceptance tests are written before its code, from the requirement ids in its spec. If a lane needs a change in another lane's interface, it stops and files a change request; it never edits that package.

## Lanes

| Lane | Package(s) | Wave | Hours | Money lane |
|---|---|---|---|---|
| 00 scaffold | root, `scripts/`, all package shells | 0 | 6 | no |
| 01 contracts | `packages/contracts` | 1 | 5 | yes (types) |
| 03 transport and fixtures | `packages/transport`, `fixtures/paypal` | 1 | 6 | yes |
| 11 security | `packages/security` | 1 | 7 | no |
| 12 runtime, obs, db | `packages/runtime`, `packages/obs`, `packages/db` | 1 | 8 | yes (schema) |
| 13 model | `packages/model` | 1 | 4 | no |
| 17 CI and evidence | `scripts/`, `.github/`, `docs/evidence` | 1 | 5 | no |
| 02 config and safety | `packages/config`, `packages/safety` | 2 | 6 | yes |
| 04 PayPal adapter | `packages/paypal` | 2 | 8 | yes |
| 06 approval | `domain/approval` | 2 | 6 | yes |
| 07 entitlements and clock | `domain/entitlements`, `domain/access-clock` | 2 | 8 | yes |
| 08 ledger and receipts | `domain/ledger`, `domain/receipts` | 2 | 6 | yes |
| 09 delivery | `domain/delivery` | 2 | 6 | yes (readiness, evidence) |
| 14a catalogue and offer entry | `domain/catalogue`, `domain/offer-entry` | 2 | 6 | no |
| 14b discovery and fit | `domain/discovery`, `domain/fit` | 2 | 6 | no |
| 05a payments order and capture | `domain/payments` (part) | 3 | 10 | yes |
| 05b payments reconcile and jobs | `domain/payments` (part), `packages/jobs` | 3 | 9 | yes |
| 10 recovery and library | `domain/recovery`, `domain/library` | 3 | 6 | no |
| 16 testkit and conformance | `packages/testkit` | 3 | 6 | yes |
| 15 web | `apps/web` | 3 | 12 | no (routes reviewed by Opus) |
| 18 MVP-A gate | `tests/mvp-a`, `docs/evidence` | 4 | 6 | gate |

Total about 148 worker hours (about 18.5 lane-days at 8 h), close to the 21 lane-days in `mvp-plan.md` with the defect loops included.

## Waves (6 to 8 workers at a time)

- Wave 0 (now): 00.
- Wave 1 (6 workers, after 00 merges): 01, 03, 11, 12, 13, 17. Lanes 03, 11, 12, 13 code against the exact interface text in lane 01's spec and rebase when the freeze they need merges (03 needs F2; 11, 12, 13 need F1).
- Wave 2 (8 workers, after 01 F3 and 12 merge): 02, 04, 06, 07, 08, 09, 14a, 14b. Inside the wave: 04 needs 03 merged; 08 merges after 06 (it imports `canonicalJson`); 09 merges after 07; 14b merges after 14a and 13.
- Wave 3 (5 workers, after wave 2 merges): 05a, 05b, 10, 16, 15. 05b and 10 code against 05a's signatures and merge after it. 15 may start its design system and static pages during wave 2 using fixtures.
- Wave 4: 18, then the MVP-A gate review.

## Dependency graph

```
00 ─┬─ 01(F1,F2,F3) ─┬─ 02 ────────────────────────────┐
    │                ├─ 04 (also 03) ───────┐          │
    ├─ 03 (F2) ──────┤                      │          │
    ├─ 12 (F1) ──────┼─ 06 ─────────────────┤          │
    ├─ 11 (F1, 12) ──┤                      ├─ 05a ─┬─ 05b ─┐
    ├─ 13 (F1) ──────┼─ 07 ─ 09 ────────────┤       ├─ 10 ──┤
    └─ 17            ├─ 08 (06) ────────────┘       │       ├─ 15 ─ 18
                     ├─ 14a ─ 14b (13) ─────────────┼───────┤
                     └─ 16 (03, 04, 12, 14a) ───────┘       │
                                                    02, 11 ─┘
```

## Interface owners (one owner per shared interface)

| Interface | Owner lane | Frozen by |
|---|---|---|
| All cross-package types in `@umsbx/contracts` | 01 (coordinator as owner of record) | F1, F2, F3 merges |
| Database schema and migrations | 12 | lane 12 merge |
| Fixture file format and scenario names | 03 | lane 03 merge |
| `Config`, `BootRefusal`, switch and gate semantics | 02 | lane 02 merge |
| `PayPalPort` behaviour (mapping and error map) | 04 | lane 04 merge |
| `withRoute`, `RouteMeta`, session and CSRF | 11 | lane 11 merge |
| `requestApproval`, `verifyApproval`, `markUsed`, `contentHash`, `canonicalJson` | 06 | lane 06 merge |
| `applyMoneyEvent`, `computeWindow`, evidence semantics | 07 | lane 07 merge |
| `appendLedgerEntry`, receipt body and hash | 08 | lane 08 merge |
| `issueLink`, `planServe`, `checkReadiness`, link token | 09 | lane 09 merge |
| `startFromOffer`, no-match order, seed data | 14a | lane 14a merge |
| `computeFit`, fit rules | 14b | lane 14b merge |
| `placeOrder`, `onBuyerReturn`, `matchReadback`, `applyReadback` | 05a | lane 05a merge |
| `reconcileOrder`, `runDue`, refunds, job loop | 05b | lane 05b merge |
| `openCase`, library model | 10 | lane 10 merge |
| Conformance cases P1 to P15, D1 to D6 | 16 | lane 16 merge |
| Composition root, UI tokens | 15 | lane 15 merge |
| Gate report format | 17 | lane 17 merge |

## Contracts freeze order

1. F1 (hour 1.5 of lane 01): primitives, `Result`, `Database`, `SqlExecutor`, `Clock`, `Ids`, `Secret`, `Logger`, `AuditSink`, `ContentStore`, `ModelPort`, `SwitchReader`, `Actor`. Unblocks 11, 12, 13.
2. F2 (hour 3): `Transport`, `OutboundRequest`, `TransportResult`, `OutboundGate`, `PayPalPort` and every PayPal result type. Unblocks 03 and, later, 04.
3. F3 (hour 5): corridor, catalogue, quote, snapshot, approval, expected transaction, operation, order and unit statuses, money, access and window, ledger, receipt, recovery, fit, `DomainConfig`, `CoreDeps`, `PaymentsDeps`, `AgentDeps`. Unblocks wave 2.

After a freeze, a change is a contracts change request (CCR): the requesting lane writes the diff and the reason; the Opus reviewer checks every consumer; lane 01's owner merges; consumers rebase. Additive changes only during MVP-A.

## Opus verification plan

| Lane | Review | Mutation check | Extra |
|---|---|---|---|
| 01 | Full diff review against the spec's interface text | no | export snapshot test |
| 03 | Diff review | no | guard table reviewed against architecture 7 |
| 12 | Diff review of every migration | no | constraint tests reviewed for race and tamper cases |
| 02 | Diff review | no (logic is table-tested) | boot refusal matrix reviewed |
| 04 | Diff review | `money.ts`, `map-*.ts` at least 80 percent | error map compared row by row with architecture 9.1 |
| 06 | Diff review | `canonical.ts`, `approval.ts` verify path | tamper tests reviewed |
| 07 | Diff review | `table.ts`, `compute.ts` at least 80 percent | property tests reviewed for real invariants |
| 08 | Diff review | `ledger.ts` at least 80 percent | refund bounds reviewed |
| 09 | Diff review | `readiness.ts` | header and isolation tests reviewed |
| 05a | Diff review, second review if any FIX | `match.ts`, `apply.ts` at least 80 percent | provider-call-in-transaction spy present; claim never unlocks |
| 05b | Diff review, second review if any FIX | `reconcile.ts`, `due.ts` at least 80 percent | 5 h resend limit and crash recovery reviewed |
| 16 | Diff review | no | cases traced to verified facts, not to the adapter |
| 15 | Composition and routes reviewed; UI by screenshots | no | every route has `RouteMeta`; no secret path to the client |
| 11 | Diff review | no | adversarial set reviewed |
| 10, 13, 14a, 14b, 17 | Gates plus a short Opus read of the acceptance tests | no | 14b fit honesty reviewed by Opus |
| 18 | Full MVP-A gate review | runs all | SOP 22 report signed off before MVP-B |

Money lanes (01 types, 02, 03, 04, 05a, 05b, 06, 07, 08, 09, 12 schema, 16) also need: branch coverage at least 90 percent and line coverage at least 95 percent (nfr.md MAINT-6, pending O-4 for the coverage tool), and zero open critical or high review findings before merge.

Simulation proves modelled cases only, not PayPal compatibility.
