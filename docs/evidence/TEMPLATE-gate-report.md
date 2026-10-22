# Gate report: <MVP gate id, for example MVP-A> <title>

Format: nfr.md SOP section 22. Copy this file to `docs/evidence/gate-<gate>-<date>.md` and fill it in.
Offline only. No environment values, no tokens, no raw ids: shorten ids to four characters.

- Gate: MVP-<A to F>
- Date: <YYYY-MM-DD>
- Commit: <six characters>
- Author: <name> Reviewer: <name>
- Evidence runs: `docs/evidence/<lane>-<date>.md` (link each)

## Verdict

Choose one and delete the others.

- [ ] APPROVED FOR SANDBOX DEMO
- [ ] APPROVED WITH CONDITIONS (list each condition and its owner and date under Findings)
- [ ] NOT APPROVED

One paragraph: why this verdict, in plain words.

## Findings by severity

One block per finding. Order: Critical, High, Medium, Low. Write "none" under a severity with no finding.

### Critical

none

### High

none

### Medium

none

### Low

none

Block format:

```
#### F-<n> <short title>
- Issue: what is wrong, observed (command and result).
- Risk: what could go wrong and for whom.
- Impact: money, access, secrets, availability or process.
- Fix: the smallest change that closes it; who and when.
- Files: path[:line], path[:line]
- Status: open | fixed in <six character commit> | waived until <date> (reason, approver)
```

## Control checklist (nfr.md section 1.3)

Tick only what a command or a reviewer observation proves; write the proof next to the box.

- MVP-A walking skeleton: [ ] SOP 1, 2, 3 (constraints), 6 (tool limits), 7, 12, 20 (pipeline) [ ] P3 [ ] P4 [ ] P5 [ ] P12 [ ] P15 [ ] P16 [ ] AI-3 [ ] gitleaks full history clean
- MVP-B single publisher end-to-end: [ ] SOP 3, 4, 6, 7, 15, 17, 18, 19 [ ] P6 [ ] P7 [ ] P10 [ ] P11 [ ] P13 [ ] P14 (route streaming) [ ] P17 [ ] AI-1 [ ] AI-2 [ ] AI-4 [ ] AI-5
- MVP-C hosted with webhooks and refunds: [ ] SOP 4 (operator MFA), 5, 8, 9, 10, 14, 17, 18, 20 (ZAP), 21 [ ] P1 [ ] P2 [ ] P8 [ ] P9 [ ] restore drill [ ] runbook dry run
- MVP-D two publishers: [ ] SOP 16 if uploads exist [ ] P18 [ ] P5 re-run per unit [ ] P11 per publisher
- MVP-E WordPress entry path: [ ] SOP 16, 18 (SSRF) [ ] P19 [ ] AI-1 re-run on WordPress content
- MVP-F hardening and submission: [ ] SOP 1, 11, 12, 13, 14, 20, 21, 22, 23 [ ] secret rotation [ ] ZAP re-run [ ] restore drill [ ] full checklist re-ticked

## Machine checks

| Check                                                    | Command                                         | Result (exit, counts)                  |
| -------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| Offline set                                              | `corepack pnpm evidence --lane <id>`            |                                        |
| Mutation score >= 80 percent (MAINT-4)                   | `corepack pnpm mutation`                        |                                        |
| Branch coverage >= 90 percent on money modules (MAINT-6) | pending approved coverage package               |                                        |
| Bundle secret scan (A-25)                                | `corepack pnpm check:bundle` after `next build` |                                        |
| Fixture lint (MAINT-5)                                   | `corepack pnpm check:fixtures`                  |                                        |
| Dependency audit (SUP-2)                                 | `corepack pnpm audit --prod`                    | zero high or critical, or dated waiver |
| gitleaks full history (SUP-6)                            | `gitleaks git --no-banner --redact`             |                                        |

## Not tested, and assumptions

List what this gate did not cover and every UNVERIFIED item it relies on.
