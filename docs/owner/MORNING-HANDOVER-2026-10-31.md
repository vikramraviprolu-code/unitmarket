# Morning hand over, Saturday 31 Oct 2026 (DOCS-B)

For: Vikram and Sakthi. Written on 30 Oct 2026 by the DOCS-B lane against `main` at commit `cb8eabe`. It is a snapshot: the
coordinator merges lanes during the night, so before you rely on any row run `git fetch` and `git log --oneline origin/main` and
compare. Nothing here was run against Google Cloud, PayPal or a hosted URL. No tag was created, no deploy was run, no approval row
was inserted.

## Read these first, in this order

1. `docs/owner/DECISIONS-FOR-VIKRAM.md`: the 72 items taken as working assumptions under D-065. Say "confirmed" or name numbers.
2. `docs/owner/OVERNIGHT-ASSUMPTIONS.md`: what the coordinator assumed overnight, with reasons.
3. `docs/submission/submission-text.md` and `docs/submission/testing-instructions.md`: the drafts you must approve (items 68, 69).
4. `docs/owner/DEPLOY-PREP-2026-11.md`: the exact commands for Sakthi. Run only when no owner sitting is open.
5. `docs/specs/overnight-plan.md`: lanes, order, conflicts flagged in its section 6.

## State of main at writing

On `main`: the whole payment engine and safety design, the offline Dry run, the hosted kit, the MVP-C and MVP-D evidence, the
DOCS-A documents (threat model, privacy script spec, keyboard checklist) and the overnight specs. Not on `main` yet, from `git
log` and the file tree at `cb8eabe`:

| Area                                 | State on `main`                                                                                 | Where it is                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Licence, README rewrite, notices     | Not merged. No LICENSE file; README still describes the lane 00 scaffold                        | branch `feat/repo-compliance` on origin            |
| Four config names (CFG-0)            | Not merged                                                                                      | branch `feat/config-overnight-names` on origin     |
| Neutral screen fixes (UX-1A)         | Not merged                                                                                      | branch `feat/web-ux-phase1a` on origin             |
| Publisher shell and migration 0012   | Not merged. Newest migration is 0011. Sign in has a Publisher persona with no screens behind it | local worktree only, no branch on origin when read |
| Legal pages (LEGAL-A)                | Not merged. No terms or privacy route                                                           | local worktree only, no branch on origin when read |
| Claude adapter, evals page (AI-A, B) | Not merged. No AI model is called anywhere. The scripted model composes packs                   | no branch seen                                     |
| Skins, reader, motion                | Not merged                                                                                      | no branch seen                                     |
| Signed offer links (E-L1)            | Paused (D-064)                                                                                  | branch `feat/offer-entry-signed-link`              |

When a row changes, update the TO FINALISE lines in the two submission files. Each one names the lane that settles it.

## Things that need a person, in order of date

| Date                 | What                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sat 31 Oct           | Vikram confirms the 72 items. Decide items 28 and 30 (Quayside own account and the narrow approval row).                   |
| Before Mon 2 Nov     | Money path freeze (item 31). Payee change and the transport package must merge before it, or an exception row is needed.   |
| Tue 3 Nov 12:00 Z    | The D-062 hosted approval row expires. After that the hosted app fails closed (checkout paused).                           |
| Thu 5 Nov            | Re-check the Rules, Updates and FAQ tabs (item 1). Coordinator drafts are due; owners approve (items 68, 69).              |
| Fri 6 Nov            | Feature freeze, evening (item 12). Devpost draft saved by this day (item 5).                                               |
| Sat 7 Nov            | Video recorded under its own approval row (item 66). Rotate secrets before going public (item 64). Secret scan, go public. |
| Mon 9 Nov            | Submit. Tag `submission-1`. A separate deploy tag is a different thing (see the deploy file).                              |
| Wed 11 Nov           | Re-check the rules again.                                                                                                  |
| Thu 12 Nov 21:00 CET | Submission closes and cannot be changed.                                                                                   |
| 30 Nov to 15 Dec     | Three seven day live payment windows (item 21). Each needs a new approval basis and row. Judging ends 15 Dec 08:00 PT.     |

## Risks the drafts could not hide

1. No AI model is called on `main`. The rules ask for an AI tool inside the project, and Stage 1 is pass or fail on it. The Claude
   adapter (AI-A, D-067) must merge and be switched on for at least the hosted demo, or you must decide how to present this. The
   key and the switch are human only.
2. Hosted app outside the live windows. The plan (item 23) wants a labelled Dry run path so judges always have a working purchase.
   On `main` the hosted service runs in sandbox mode, shows "Sandbox", and with the connection off the gate refuses PayPal calls, so
   a purchase does not complete. The testing instructions send judges to the offline path for a purchase until you choose between
   a second hosted service in offline mode, a mode change in a reviewed infra change, or browse only wording.
3. The hosted app cannot show publisher personas or the Claude adapter until a reviewed infra change maps their secret names
   (INFRA-A, not built) and you store the values.
4. Settlement: both publishers are paid into one sandbox account, as the 29 Oct evidence shows. The drafts say so. Replace that
   line only after the Quayside test order passes.
5. Anyone holding the shared demo passcode can sign in as Operator and press Stop on the hosted app without a code (D-040). The
   testing instructions ask judges not to press it; consider whether judges see `/ops` at all.
6. The offline run in the testing instructions is copied from the README rewrite on the `feat/repo-compliance` branch. Nobody has
   run it from a fresh clone of the public repository. Do that once, timed, before submission.
7. The deploy command file uses a shortened `env -u` prefix for one hosted status check. Check that you accept it.

## What this lane did not do

It did not run any check against a hosted URL, Google Cloud, PayPal or a browser. It did not create a tag, a branch on the public
repository other than its own, a pull request, a secret, an account or an approval row. It wrote no credential, project id,
project number, merchant id or passcode value, in any file. Its branch is `feat/docs-b-submission`; the coordinator merges it after a
review.

## Files from this lane

`docs/submission/submission-text.md`, `docs/submission/testing-instructions.md`, `docs/owner/DEPLOY-PREP-2026-11.md`,
`docs/owner/MORNING-HANDOVER-2026-10-31.md` (this file, added at the coordinator's request; the spec lists the first three).
