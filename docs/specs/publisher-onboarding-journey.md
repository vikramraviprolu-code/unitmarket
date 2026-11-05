# Publisher onboarding journey (POB): one path, walked end to end

Decision: D-089. Owners: Vikram, Sakthi. Coordinator: this session. Builders: Sonnet. Reviewer: Opus, one round per lane.
Why this exists: lanes were verified one by one and the publisher's whole path was never walked, so basic holes showed up in
the happy path (no sign-in for a new publisher, no way to add a catalogue, no payout). The rule from now on: nothing in this
journey is called done until the walk below passes, and any missing or manual step is listed first in every status.

## The journey (J1 to J14)

1. J1 Apply. A publisher applies (exists: Apply form) or an operator adds them (exists).
2. J2 Approve. An operator with the second factor approves (exists). NEW: approval shows the operator a one time invite code, once.
3. J3 Claim. The publisher opens the seller sign in, chooses "Claim your account", enters the code, chooses a username and password.
4. J4 Sign in. The publisher signs in with that username and password (the three demo personas stay for judges).
5. J5 Terms. The publisher accepts the publisher terms with a real action (today only a seeded demo record exists).
6. J6 Link PayPal. The publisher links their own PayPal account. UnitMarket never creates one.
7. J7 Add a web source. The publisher gives a web address, proves they control it, and starts an import.
8. J8 Review. Items, pictures and prices appear in a staging list. The publisher picks what to show and may edit.
9. J9 Publish. Chosen items become articles and offers. The buyer's price is the publisher's price plus UnitMarket's fee.
10. J10 Buy. A buyer finds an item in browse or search, approves, pays (dry run offline; real sandbox only under an approval row).
11. J11 Collect. The money lands in the UnitMarket collection account. The ledger records sale, fee and the amount owed to the publisher.
12. J12 Pay out. After the refund window of that sale closes, a payout to the publisher's linked PayPal is created (dry run offline).
13. J13 Statement. The publisher sees the sale, the fee, what is owed and what has been paid out.
14. J14 Refund. A refund inside the window stops the payout; the ledger stays consistent.

## Lanes

| Lane | What                                                                           | Spec                           | Depends on                                                                 |
| ---- | ------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------- |
| P1   | Publisher accounts: invite, claim, sign in, terms, PayPal link                 | `pob-p1-publisher-accounts.md` | none                                                                       |
| I1   | Web import: verify domain, fetch, extract, stage, review, publish (fee on top) | `pob-i1-web-import.md`         | feat/feed-import (old FEED lane) as the base; fee field from M1 at publish |
| M1   | Fee on top, ledger split, payout after the refund window, statement            | `pob-m1-fee-and-payout.md`     | none (I1 reads its fee setting)                                            |
| W    | The walk: one automated test of J1 to J14 in dry run, written first and red    | this file, acceptance          | all                                                                        |

The walk is `apps/web/src/pob-journey.state.test.ts`. It drives the engine methods in order (no browser needed) with a fake
clock, a scripted web source and the dry run transport. Each lane turns its steps green. A browser walk of J3 to J9 is added
to the e2e suite when the screens exist. Nothing calls PayPal or the open web in any test.

## Assumptions taken (the owner can overturn any row)

| #   | Question                    | Assumption                                                                                                                                                                                                                           |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | What the web import reads   | Structured data first (schema.org JSON-LD Product and Article, OpenGraph tags, RSS, Atom, JSON feed, sitemap). A page with none gives no items, with a plain reason. No AI extraction in v1.                                         |
| A2  | Fee rate                    | 10 percent of the publisher's price, rounded half away from zero, one setting in the database, set by an operator with the second factor, audited. Tax is a reserved zero field.                                                     |
| A3  | Who the seller is on PayPal | Linked by the email of their own PayPal Business account, verified by an operator in v1. "Log in with PayPal" (verified id, no password handled) replaces the operator check when the owner enables it in the sandbox developer app. |
| A4  | Fetch allow list            | Replaces the env host list of the old FEED lane: a host is allowed only if it is the publisher's verified domain. The address checks of the old guard stay. No deploy per publisher.                                                 |
| A5  | Item kinds in v1            | Articles (text) and single images. Other kinds are skipped with a reason.                                                                                                                                                            |
| A6  | Where files are stored      | The existing content table, with hard size caps. A bucket is the later design for thousands of photos; v1 caps the batch (100 items, 2 MB each).                                                                                     |
| A7  | Payout timing               | A sale's payout is due when its access window ends and no open refund exists. One payout per publisher and currency per run.                                                                                                         |
| A8  | Real PayPal                 | No real sandbox payout or order runs without the owner's explicit "approve" and an approval row inserted at his own terminal. Offline first.                                                                                         |
| A9  | Migrations                  | 0020 to 0027 are taken on main. Planned: P1 0028, M1 0029, I1 0030; each lane takes the next free number when it starts and again when it rebases. Coordinator renumbers on a clash.                                                 |

## Acceptance (the whole journey)

- `corepack pnpm vitest run apps/web/src/pob-journey.state.test.ts` prints `Tests  N passed` with N equal to the number of journey
  steps J1 to J14, and no step marked skipped.
- Every lane's own acceptance list passes, then lint, typecheck, format check, the six suites and `check:isolation`,
  `check:no-live-host`, `check:routes`.
- Opus review of P1 (sign in surface), I1 (fetcher and extraction) and M1 (money out), one round each, no blocker open.

Do not: connect to PayPal or the open web in any test; add a dependency without a decision row; copy code from the
simulation repository; put a secret anywhere; deploy.

## Rebuild note (5 Nov)

The first builds of P1, M1 and I1 were lost in a container reset before they were pushed. Rebuild from the lane specs, which now carry the review findings. The coordinator pushes each lane branch after every commit round, so a reset cannot take it again.
