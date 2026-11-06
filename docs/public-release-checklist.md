# Public release checklist

Prepared 5 Nov 2026 by the DOCS lane for the owner. The competition needs this repository to be public with a visible open source licence before the submission closes on Thu 12 Nov 2026, 12:00 PT. This file lists every step. **A step marked OWNER can only be done by Vikram.** The DOCS lane made no visibility change and no code change.

Checked against `main` at `16ad163` (5 Nov 2026).

## 1. What the DOCS lane already checked

| Check                                   | Result                                                                                                                                                     | Command or place                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-history secret scan, every branch  | **0 leaks.** 999 commits scanned (gitleaks skips merge commits, which carry no diff of their own; the repository holds 1,270 commits on all refs), 21.8 MB | `gitleaks git --log-opts="--all" --redact -c .gitleaks.toml` with gitleaks 8.28.0, built by `GOBIN=<dir> go install github.com/zricethezav/gitleaks/v8@v8.28.0` |
| Same scan on the history of `main` only | 0 leaks, 900 commits                                                                                                                                       | `--log-opts="HEAD"`                                                                                                                                             |
| Scan of the current tree                | 0 leaks                                                                                                                                                    | `gitleaks dir . --redact -c .gitleaks.toml`                                                                                                                     |
| Scan with the allow list removed        | **19 findings**, all covered by the allow list in `.gitleaks.toml` (eight exact fake values and five reviewed commits) and the repo's `.gitleaksignore`    | Run once with `.gitleaks.toml` moved aside, then restored. Each fake value is documented in the file header                                                     |
| Licence file                            | `LICENSE` exists at the root and is the unmodified Apache License 2.0 text; `package.json` says `Apache-2.0`; `THIRD-PARTY-NOTICES.md` exists              | `head LICENSE`, `grep license package.json`                                                                                                                     |
| Private planning document links         | **No link or URL.** Mentions reworded to "planning document" in UNI-83; `git grep -nI -i bible` finds only this row                                        | `git grep -nI -i bible`                                                                                                                                         |
| Local file paths                        | 12 mentions of `/mnt/project-files` in 8 files. A public reader cannot open them (list in section 3)                                                       | `git grep -nI '/mnt/project-files'`                                                                                                                             |
| Real contact address in the product     | Personal address replaced by the placeholder `contact@unitmarket.example` in UNI-83; swap for a real mailbox before submission                             | `git grep -nI '@googlemail.com'` finds only this row                                                                                                            |

The scan is clean today. It does not replace a second scan right before the flip (step 4), because every merge since adds history.

## 2. Steps, in order

1. **Contact address (DONE, UNI-83).** The placeholder `contact@unitmarket.example` is in place. Replace it with a real team mailbox if one exists (D-104).
2. **Planning document mentions (DONE, UNI-83).** Reworded; the owner paste pack is now `docs/owner/PLANNING-UPDATE-PACK-2026-10-31.md`.
3. **Decide the stale branches (OWNER).** The repository has 172 branches on the remote, and a public repository shows all of them. The scan covered all of them and is clean. `claude/br-slice-specs` is the one already known to need deleting (the automation gets a 403 deleting it). Recommendation: delete merged `feat/*` and `docs/*` branches after the flip is decided, or keep them as history; both are safe.
4. **Re-run the scan on the commit you will publish (any session).** Same commands as section 1. The result must say `no leaks found`. If it reports one, rotate the credential within the hour and record it in `docs/decision-log.md` (rule 4 of `CLAUDE.md`).
5. **Confirm the video footage is intended to be public.** `video/assets/footage/*.mp4` (three files, 8.9 MB) are committed. They contain dry-run footage only. The rendered cut is kept outside the repository.
6. **Wait for the final README.** The README draft is in `/mnt/project-files/competition-registration/README-draft.md`. It becomes final after E2E merges (target 8 Nov). Copy it to `README.md` in a normal PR.
7. **Flip the visibility (OWNER).** GitHub, repository Settings, General, Danger Zone, Change visibility, Make public. The DOCS lane never does this.
8. **Check the licence shows in About (OWNER).** Open the public repository page. The About box must show "Apache-2.0 license". If it does not, add or fix the licence in Settings. GitHub reads `LICENSE` at the root.
9. **Check what a visitor sees without signing in.** Open the repository in a private browser window. The README renders, the licence shows, Actions logs and the Wiki show nothing sensitive, and the Releases list is empty or intentional.
10. **Clone fresh and run offline.** On a machine with only Node 22.22.0 and Corepack: `git clone`, `corepack pnpm install --frozen-lockfile`, follow the README quickstart. The judge path must work with no credential.
11. **Paste the repository link into Devpost (OWNER).** The Representative does this, with the video link and the hosted URL.

## 3. Lists behind the checks

### planning document mentions (no URL in any of them)

- `docs/briefing/mvp-status-2026-10-23.md`: lines 17, 37, 205
- `docs/business-rules/business-rules-reference.md`: lines 33, 102, 262
- `docs/decision-log.md`: lines 52, 74 (append only; do not edit)
- `docs/design/publisher-questions-recommendations-2026-10-31.md`: line 252
- `docs/owner/PLANNING-UPDATE-PACK-2026-10-31.md`: lines 1, 3, 4, 6, 14, 46, 63, 83, 109, 128, 171
- `docs/proposals/publisher-side-proposal-2026-10-30.md`: lines 10, 21, 329
- `docs/proposals/whole-product-gap-review-2026-10-30.md`: lines 5, 23, 121, 149

### `/mnt/project-files` mentions

`docs/decision-log.md`, `docs/design/integrated-plan-2026-11-04.md`, `docs/specs/int-buy.md`, `int-cl1-cloud-kit.md`, `int-rubric.md`, `int-sel.md`, `int-sim-u2.md`, `int-ui0-shell.md`. They point at the project's working folder. They are harmless but dead links for the public. The decision log is append only, so leave it.

### Contact address

Copy sources: `apps/web/src/lib/account-copy.ts:7`, `apps/web/src/lib/legal-copy.ts:152` and `:294`.

Golden text files: `apps/web/src/golden/account-copy.golden.txt:1, 22, 97` and `apps/web/src/golden/legal-copy.golden.txt:45, 49, 97`.

Golden tests: `apps/web/src/account-copy.golden.test.ts:160` and `apps/web/src/legal-copy.golden.test.ts:88, 134, 165, 212`.

E2E: `apps/web/e2e/accounts.spec.ts:245`.

Docs: `docs/owner/OVERNIGHT-ASSUMPTIONS.md:50` and `docs/specs/id-accounts-landing.md:12`.

## 4. What this lane did not do

It did not change visibility, delete branches, edit the decision log, change code, or run any PayPal call. The simulation repository (`AIC_Hackathon_UnitMarket`) stays private; no public file here links to it.
