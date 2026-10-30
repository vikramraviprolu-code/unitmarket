# Final hand over, Saturday 31 Oct 2026 (FINALISE-DOCS)

For: Vikram and Sakthi. Written on 30 Oct 2026 by the FINALISE-DOCS lane against `origin/main` at commit `a897c69`. This replaces the
first hand over written at `cb8eabe`. It is a snapshot: before you rely on any row run `git fetch` and `git log --oneline origin/main`
and compare. Nothing here was run against Google Cloud, PayPal or a hosted URL. No tag was created, no deploy was run, no approval row
was inserted, and the lane read no env file and held no credential.

The AI and payment claims in this file are limited to what the code and tests show. Sandbox settlement is still one owner test account
for both publishers. Paying Quayside Gazette directly is not built or tested. No real AI call has ever been made. No hosted deploy has
happened with any of the features listed below.

## Read these first, in this order

1. `docs/owner/DECISIONS-FOR-VIKRAM.md`: the 72 items taken as working assumptions under D-065, now with a status table (DONE,
   PARTIAL, HUMAN-ONLY). Say "confirmed" or name numbers.
2. `docs/owner/OVERNIGHT-ASSUMPTIONS.md`: 33 assumptions with reasons. The risks section below points to the rows that need you.
3. `docs/submission/submission-text.md` and `docs/submission/testing-instructions.md`: drafts you must approve (items 68, 69). Each
   remaining **TO FINALISE** marker is a human step or something not built.
4. `docs/owner/DEPLOY-PREP-2026-11.md`: the exact commands for Sakthi. Run only when no owner sitting is open.
5. `docs/specs/overnight-plan.md`: lanes, order, conflicts.

## What is merged on `main`, by area

Commit pointers are short hashes from `git log origin/main`. The number after "assumption" is the row in
`docs/owner/OVERNIGHT-ASSUMPTIONS.md`.

| Area                               | What exists on `main`                                                                                                                                                                                                           | Commits and assumptions                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Licence, README, notices           | Apache-2.0 `LICENSE`, dependency licence audit, `THIRD-PARTY-NOTICES.md`, README with status and offline run, `check:licences` inside `ci` (L2)                                                                                 | `b3b6a91`, `5b5c723`, `cf184c8`, `68b87ea`; assumptions 12, 13                                                          |
| Config names and environment guard | Four new config names with safe defaults (CFG-0). Boot refuses when the process environment overrides the env file (GUARD, F8 follow-ups)                                                                                       | `2607e39`, `78f312b`, `bf21a89`, `2031660`; assumptions 10, 16                                                          |
| Neutral screen fixes               | Receipt titles and publisher, browse all, terms before the tick, no merchant id for buyers, whole ops reference (UX-1A, L1)                                                                                                     | `26a47f8`, `5c07eb0`, `b06028c`; assumption 11                                                                          |
| Legal pages                        | Four draft pages (terms, privacy, refund policy, publisher terms), footer links, privacy notice on sign in (LEGAL-A)                                                                                                            | `d26258a`, `dea5cbb`, `2da0fa7`                                                                                         |
| AI adapter                         | Claude adapter behind the model port, off by default, one fixed outbound host, spend caps, stop switch, key redaction (AI-A, D-067). Reason text scrubbed, served model recorded, per IP discovery limit (AI-H)                 | `6bd23d1`, `81d9023`, `786ab0d`, `3115018`, `c8bd27e`; assumptions 1, 2, 8, 26                                          |
| Operator evals page                | Cases, verdicts and keyword baseline against the scripted model and recorded results (AI-B)                                                                                                                                     | `4ba97e0`, `a967143`, `c9ad3ee`; assumptions 27, 28                                                                     |
| Publisher area                     | Three publisher personas, shell and migration 0012 (PUB-A1). Payee change requests and operator verification, refused outside the dry run (PUB-A2). Offer revise and withdraw, demo prices (PUB-B). Sales and statement (PUB-C) | `1215cc5`, `112b979`, `c4c2f64`, `9992098`, `0ca91b5`, `e51671f`, `ddaa077`, `7758fcf`, `01f8788`; assumptions 3, 4, 18 |
| Operator publishers page           | Exposure read model, suspend, links from the publisher home (PUB-D)                                                                                                                                                             | `82280a6`, `4032ece`; assumption 32                                                                                     |
| Reader view                        | In app reader with the time left meter, rate limit and evidence parity (READER-A)                                                                                                                                               | `e3d2bca`, `52adb27`, `2933b76`                                                                                         |
| Skins and motion                   | Skin system and Appearance control (SKIN-A). Bright Market poster look (SKIN-B1). Deep Harbour and the motion set (SKIN-B, SKIN-B2)                                                                                             | `b162eeb`, `d1d5e03`, `cacf367`, `c7c43d6`, `34feae6`, `d7cc5c8`; assumptions 5, 25                                     |
| Sign out and navigation            | Sign out, navigation per role, honest unpaid order wording, focus and skin switch without reload (FIX-FLOW)                                                                                                                     | `658ed75`, `89147d9`; assumption 29                                                                                     |
| Gate fixes                         | Copy and README fixes (FIX-DOCS), defects D2 to D11 (GATE35-FIX): unpaid item page, refund wording, operator code message, dry run fees, paid only sales, discover need kept                                                    | `dcabfa7`, `1237080`, `408a5c0`, `65c52a2`; assumption 30                                                               |
| Judge passcode                     | A separate passcode that signs in Buyer A and Buyer B only (JUDGE-A)                                                                                                                                                            | `ed20333`, `f34fa74`; assumption 22                                                                                     |
| Deploy kit                         | Optional secrets by name and an offline judge service variant, `deploy-offline.sh` (INFRA-A). Prepared, never run by an agent                                                                                                   | `3bef9f9`, `85eb1e1`, `b80af7b`; assumptions 6, 16, 21, 24                                                              |
| Close out documents                | Threat model, privacy script spec, keyboard checklist (DOCS-A). Submission text, testing instructions and deploy prep (DOCS-B)                                                                                                  | `d4db36e`, `ce07ca8`, `617cd2b`                                                                                         |
| Repairs after merge                | Offline scripts load again; maintenance test lists the only `node:fs` importers; isolation scan skips design previews                                                                                                           | `b9ca8b1`, `aefb3f5`; assumptions 9, 33                                                                                 |
| Recorder fix (B-13)                | Recorder drops documentation links. The fixtures push itself is human only (below)                                                                                                                                              | `4e9e1bb`, `b7b35b2`                                                                                                    |

## Not merged

| Area                                      | State                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer cancel of an unpaid order (ORDER-A) | TO FINALISE. On branch `feat/order-a-cancel` (`c218860`, tests `3f3e28a`), not on `main` at the time of writing. Money path lane; needs its Opus review. Assumption 29 |
| Quayside direct payee                     | Not built or tested. Needs a second sandbox Business account and a new approval row                                                                                    |
| Privacy export and delete script          | Specified in `docs/specs/ops-privacy-export-delete.md`, not written                                                                                                    |
| Signed offer links (E-L1)                 | Paused (D-064), branch `feat/offer-entry-signed-link`                                                                                                                  |
| Accessibility scan with axe-core          | Not added. The dependency waits for your confirmation (item 55). The keyboard checklist exists in `docs/evidence/keyboard-pass-checklist.md`, not yet carried out      |

## Test status

State of the suites as the coordinator last ran them is not asserted here, because this lane ran no suite. Only `prettier --check`,
`check:no-live-host` and `check:secrets-names` were run for this lane. The `state` suite has one known expected
failure (`docs/specs/overnight-plan.md` section 3). The browser suite lists 27 tests in 6 files (`playwright test --list`).

FINAL TEST BATCH (30 Oct 2026, commit `27d2680`, then `e7560e7` with a contact address change): lint, typecheck and format clean. Unit 3,738,
state 1,971 (1 expected fail), contract 290, integration 514, adversarial 1,095, golden 114: all pass. End to end in a real browser: 57 of 57.
The final real-browser walk in both skins found no blocker; its defects were fixed (GATE-FINAL-FIX2). The change after that batch (contact
address on the privacy page and publisher terms, its test and one doc) was checked with the legal tests, lint, typecheck and format only.

DEPLOY RECORD (30 Oct 2026, done by Sakthi, human only): tag `gcp-pub-1` on commit `e7560e77e70a`. Backup before the deploy: automatic backup of
30 Oct 03:00 UTC, `SUCCESSFUL`. Cloud Run revision `unitmarket-sandbox-00013-6wx` serving 100 percent. The five optional secrets have no value, so the
publisher console, judge passcode, offer cap and Claude adapter are off. Checked in a browser: sign in as Buyer A, discover with fit cards, demo
price changes applied, `/legal/privacy` live, `/ops` shows `paypal_outbound` Off. The app is configured for the address
`https://unitmarket-sandbox-626887286871.europe-west3.run.app`; the other Cloud Run address gives a NOTE from `deploy.sh` and is not used for sign in.
Second deploy the same evening: Sakthi stored `UMS_JUDGE_PASSCODE_HASH` and `UMS_PUBLISHER_PASSCODE_HASH` in Secret Manager (hashes made in Cloud Shell, never printed or
shared) and deployed `gcp-pub-1` again: revision `unitmarket-sandbox-00014-mjz`, both secrets `on`. Four sign in checks passed: the judge passcode signs in
Buyer A, the judge passcode is refused for Operator, the publisher passcode opens the publisher console, the publisher passcode is refused for Buyer A.
Not done: offline judge service, offer cap, Claude adapter and key, real PayPal purchase on this build (needs a new approval row from the owner).

## Human only steps, in order

Every item below is a person's action. No agent does any of them.

1. **Decisions (Sat 31 Oct).** Vikram says "confirmed" or names item numbers from `DECISIONS-FOR-VIKRAM.md`. Decide items 28 and 30
   (Quayside own account and the narrow approval row).
2. **Fixtures push (item 60).** Sakthi pulls `main`, re-runs `record:fixtures` as item 60 says, and
   pushes the branch `feat/transport-b13-fixtures`. The coordinator checks it before merge.
3. **Second sandbox Business account (item 29).** Vikram creates a US Business sandbox account in his developer account. Do not
   paste its values anywhere.
4. **Approval rows.** Only at a terminal with `corepack pnpm safety:approve`, each written first in `docs/decision-log.md`: the
   narrow Quayside test order (item 30), the hosted D-062 renewal if needed before 3 Nov 12:00 UTC (item 61), the video recording
   (item 66), and the three judging windows later (item 21).
5. **Secrets.** Store values with `bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" NAME` for the optional names in
   `DEPLOY-PREP-2026-11.md`: `UMS_PUBLISHER_PASSCODE_HASH`, `UMS_JUDGE_PASSCODE_HASH`, `UMS_AI_ADAPTER`, `UMS_ANTHROPIC_API_KEY`,
   `UMS_OFFER_MAX_MINOR`. Make the two hashes with `corepack pnpm owner:secrets` at a terminal; they must differ from each other
   and from the demo hash.
6. **Deploy commands.** Steps 1 to 8 of `DEPLOY-PREP-2026-11.md`: reviewed commit and `ci`, backup, tag, `deploy.sh`, first checks.
   Optional step 6b deploys the offline judge service. Run when no owner sitting is open. Migration 0012 is forward only.
7. **Judge account (items 22, 24).** Create one sandbox Personal buyer for judges; choose the judge passcode; put both only in the
   Devpost form; rotate both after judging.
8. **Real AI check.** With the key stored and the adapter on, make one real brief. Until then the texts must not say Claude runs in
   the demo.
9. **Video (item 66).** Sakthi records on Sat 7 Nov under its own approval row. Under 3 minutes, no music, public on YouTube.
10. **Rotate and go public (items 64, 9).** Rotate every secret exposed during building, run gitleaks on the full history, then make
    the repository public (Sat 7 or Sun 8 Nov). Set the licence in the About section.
11. **Devpost.** Representative registers (item 2), team members confirm eligibility (item 3), save a draft by Fri 6 Nov (item 5),
    paste the approved submission text and testing instructions with credentials in the form only, run Path A from a fresh clone once,
    timed, submit Mon 9 Nov, tag `submission-1` (item 12). Re-check the Rules, Updates and FAQ tabs on 5 Nov and 11 Nov (item 1).
    The submission closes Thu 12 Nov 21:00 CET and cannot be changed.
12. **Judging windows.** 30 Nov, 7 Dec and 14 Dec: each needs a new written approval basis and row. Judging ends 15 Dec 08:00 PT.

## Risks and open owner decisions

1. **Mismatch counted as sales (assumption 30).** The sales page counts units with status `mismatch`. Keep it or change it by a
   decision row.
2. **AI-use wording (assumption 11).** Read the AI-use lines in `apps/web/src/lib/buyer-copy.ts` and the legal pages; they are drafts, not legal
   advice.
3. **Approval window gap after suspend (assumption 32).** An approval made before a suspension or withdrawal can still be placed
   inside its 15 minute window. A KNOWN GAP test pins it. A fix touches the money path and needs a reviewed lane.
4. **Offline service operator access (assumptions 22, 24).** The offline judge service has one passcode that also opens Operator;
   Stop there affects only in memory data, and a redeploy recovers. DEPLOY-PREP open question 7 asks whether to add a judge hash
   there.
5. **Unused screenshots (assumption 31).** Seven tracked files under `apps/web/e2e/shots` are unused. Say if they may be deleted.
6. **sharp LGPL exception (assumption 13).** `@img/sharp-libvips-*` is LGPL-3.0-or-later, allowed by an exact match entry with a
   written reason. Confirm it is acceptable for an Apache-2.0 repository.
7. **axe-core dependency (item 55).** Needs your confirmation under D-008 before it is added.
8. **Hosted rehearsal rows (item 62).** Approval rows from rehearsals stay, because the table is append only.
9. **Stray env file (assumption 23).** A git ignored `.env.local` sits at the root of `/home/user/sbx-wt-config-guard`. It was never
   opened. You decide whether to delete it; do not delete the worktree before then.
10. **Shared publisher passcode (assumption 18).** One hash serves all three publishers. Acceptable for a sandbox demo; split later
    if wanted.
11. **No real AI call and no hosted deploy.** The submission rules ask for an AI tool inside the project. The adapter is merged but
    unproven against the real service, and nothing built overnight is on the hosted app.
12. **Hosted app outside the live windows (assumption 21).** The hosted sandbox service cannot finish a purchase with the connection
    off. The offline judge service fixes that once deployed; otherwise word the instructions as browse only.
13. **Stale text in `DEPLOY-PREP-2026-11.md`.** Its step 1 item 4 still says the newest migration is 0011. Migration 0012
    (`packages/db/migrations/common/0012_publisher_side.sql`) is on `main`. Its rollback paragraph says older code on the 0012 schema
    is unchecked; that stays true. This lane did not edit that file.
14. **Shortened `env -u` prefix** in the DEPLOY-PREP status check (its open question 1). Check you accept it.

## Rollback

1. Nothing hosted changed overnight, so there is nothing to roll back there. Local rollback is by git.
2. To drop a lane from `main`, revert its commit range with `git revert -m 1 <merge commit>` where a merge commit exists, or
   `git revert <first>^..<last>` for a plain range, on a branch, and have it reviewed. Never rewrite `main`. Use the hashes in the table
   above.
3. Existing tags are `gcp-mvpc-1`, `mvp-a-gate-2026-10-22` and `mvpd-sbx-1`. The last tag before the overnight work is `mvpd-sbx-1`.
   Nobody has created `submission-1` or a deploy tag.
4. A hosted rollback is `deploy.sh` run again with the previous tag (DEPLOY-PREP, Rollback). Migration 0012 is forward only; restore
   from the backup taken in step 2 if the old code cannot run on it.

## What this lane did not do

It did not run any check against a hosted URL, Google Cloud, PayPal or a browser, and it ran none of the six suites. It did not
create a tag, a pull request, a secret, an account or an approval row. It wrote no credential, project id, merchant id or passcode
value in any file. Its branch is `docs/finalise`; the coordinator merges after review.

## Files from this lane

`README.md`, `docs/submission/submission-text.md`, `docs/submission/testing-instructions.md`,
`docs/owner/MORNING-HANDOVER-2026-10-31.md` (this file), `docs/owner/DECISIONS-FOR-VIKRAM.md`.
