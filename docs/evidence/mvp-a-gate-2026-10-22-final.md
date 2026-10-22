# Gate report (final): MVP-A walking skeleton, offline

Format: nfr.md SOP section 22. Offline only. No environment values, no tokens, no raw ids.
This report replaces `mvp-a-gate-2026-10-22.md`, which stays as history and carries a `superseded` banner.

- Gate: MVP-A
- Date: 2026-10-22
- Reviewed commit: main 364af49 (Opus gate review). Conditions closed by `fix/gate-conditions` (FIX-GATE2) and `test/mutation-payments` (MUT-PAY), both merged into main afterwards.
- Verdict: **APPROVED WITH CONDITIONS**

## Verdict

- [ ] APPROVED FOR SANDBOX DEMO
- [x] APPROVED WITH CONDITIONS
- [ ] NOT APPROVED

All earlier open findings are closed: OD-1 and OD-2 (FIX-PAY2, tests now `payments-readback.integration.test.ts`), F-1 (A-01 wording), F-2 (D-017: `postcss` pinned, audit clean), F-3, F-4. F-6 (mutation score of `packages/paypal/src/map-*.ts`) now scores 91.7. No critical or high finding is open. The review's findings M1, M3, M4 and L1 to L4 are fixed on `fix/gate-conditions` (below).

### Conditions

1. **Set `UMS_TRUSTED_PROXIES` before any hosted demo** (`docs/READINESS.md`, D-022). Without it every client shares one login limiter bucket.
2. **PORT-1 (stock Postgres CI)** needs an owner waiver or a run. All runs so far are PGlite.
3. **Real-Postgres race tests** before MVP-C.
4. Mutation scores for the payments files are measured on `--max 60` samples with narrow test commands (below); `capture.ts` is 81.7 percent, a thin margin. Sibling workers loaded the CPU during the runs, and the script counts a timeout as a kill, so treat the after-scores as at most slightly inflated.
5. No PayPal sandbox contact has happened or is approved: D-011 stays in force. Simulation tests prove the modelled cases only, not PayPal compatibility.

## Numbers

| Measure                    | Result                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Test files                 | 165                                                                                    |
| Tests                      | 1851 passed, 15 skipped, 0 failed (`pnpm test`, six projects)                          |
| The 15 skipped             | all `packages/paypal` sandbox contract subject; owner-enabled only                     |
| End to end                 | 15 of 15 journeys pass (`pnpm test:e2e`)                                               |
| Sockets                    | zero under the net trace (preload logging every socket connect, tls connect and fetch) |
| Dependency audit           | clean (`pnpm audit --prod`, D-017)                                                     |
| Crash and restart evidence | 77 of 77 capture crash points, 80 lost-answer points, 56 of 56 refund crash points     |
| IDOR probes                | 19 probes, all refused                                                                 |
| gitleaks                   | see Machine checks                                                                     |

## Mutation scores

| Target                               | Score                              |
| ------------------------------------ | ---------------------------------- |
| `packages/paypal/src/map-*.ts`       | 91.7                               |
| `domain/payments/src/match.ts`       | 89.3                               |
| `domain/entitlements/src/table.ts`   | 100.0                              |
| `domain/ledger/src/ledger.ts`        | 86.4                               |
| `domain/access-clock/src/compute.ts` | 89.4                               |
| `packages/paypal/src/money.ts`       | 100.0                              |
| `domain/payments/src/reconcile.ts`   | 96.7 percent (58/60), sample of 60 |
| `domain/payments/src/refunds.ts`     | 83.3 percent (50/60), up from 75.0 |
| `domain/payments/src/due.ts`         | 90.0 percent (54/60), up from 53.3 |
| `domain/payments/src/capture.ts`     | 81.7 percent (49/60), up from 61.7 |

## Findings of the Opus gate review and their fixes

| Id  | Fix (branch `fix/gate-conditions`)                                                                                                                                                                                     | Proving test                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M1  | Dry-run send reads `paypal_outbound` first and answers `blocked kill_switch` (`payments_paused`). Offline seed turns the switch on (`seed:dryrun`); sandbox mode keeps it off. D-021.                                  | `tests/mvp-a/dryrun-kill-switch.integration.test.ts`                                                                      |
| M3  | `UMS_TRUSTED_PROXIES` (0 to 3, default 0) in `packages/config`, passed to `SecurityDeps`. A spent shared `no-address` bucket refuses wrong passcodes only; a right one signs in and resets that persona bucket. D-022. | `packages/security/src/lockout.state.test.ts`, `apps/web/src/lockout.state.test.ts`, `packages/config/src/config.test.ts` |
| M4  | This report; old report bannered; READINESS updated; "OPEN DEFECT" names and headers removed.                                                                                                                          | `tests/mvp-a/payments-readback.integration.test.ts`                                                                       |
| L1  | Weak tests strengthened (see commit).                                                                                                                                                                                  | `tests/mvp-a/safety-a01-a04`, `payments-a10-a17`, `repo-a23-a27`, `isolation-a20-a21`                                     |
| L2  | Footer and page description follow the stored environment label.                                                                                                                                                       | `apps/web/src/envcopy.test.ts`                                                                                            |
| L3  | A label that contradicts the mode refuses boot (`label_mode_mismatch`).                                                                                                                                                | `packages/config/src/config.test.ts`                                                                                      |
| L4  | `next-env.d.ts` and `tsconfig.json` committed in post-build form, skipped by prettier and eslint; root scripts use `corepack pnpm`.                                                                                    | `scripts/next-build-stable.test.ts`                                                                                       |

## Machine checks

Run on `fix/gate-conditions`: `corepack pnpm format:check`, `lint`, `typecheck`, `test`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:fixtures`, `check:routes`, `check:provenance`, `check:bundle` after `flock /tmp/sbx-next-build.lock corepack pnpm --filter @umsbx/web build`, `test:e2e`. Results are in the worker's final message and were all clean at the commit named there.

## Not tested, and assumptions

- Nothing here touched PayPal. The dry-run model is synthetic.
- With no client address and `UMS_TRUSTED_PROXIES=0`, brute force of the demo passcode is bounded by the scrypt cost and the passcode strength only (condition 1).
- The mutation figures, crash-point counts and IDOR count are carried from the review and the earlier gate runs; they were not re-run by FIX-GATE2.
