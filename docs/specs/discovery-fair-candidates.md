# CAT-1: fair discovery after a bulk import

Task: a buyer's request reaches the offers that match it, even after one publisher imports 1,000 photos.
Package: `domain/discovery`, `domain/catalogue` (one new read). Owner: Vikram. Reviewer: Opus gate.
Branch: `claude/project-thread-ol1ucn` (the session's assigned branch, as POB-Q1 used `claude/project-thread-cjl8m2`). Lane id: CAT-1. Linear: UNI-142. No migration. No new dependency. No
PayPal call, credential or approval row.

## Goal

Today `candidatesFor` (`domain/discovery/src/discover.ts`) hands the model the first 50 authorised offers per
corridor in offer id order (`listAuthorisedOffers`, `ORDER BY o.id, o.version`), whatever the buyer asked. One
1,000-photo import (POB-Q1/Q2) can fill all 50 and push every other publisher out of view. When done:

1. **CAT-1.1 Match first, fairly, in SQL.** New `listAuthorisedOffersMatching(db, { corridor_id, words,
   per_publisher, limit })` in `domain/catalogue/src/read.ts`, answering `{ view: OfferView; score: number }[]`.
   - A CTE applies every guard of `listAuthorisedOffers` first: enabled corridor, `authorised`, not superseded, the
     newer-version `NOT EXISTS`, active publisher, payee country, authorisation row. It also keeps only score > 0.
     Only then does `ROW_NUMBER() OVER (PARTITION BY o.publisher_id ORDER BY score DESC, o.id)` cap rows at
     `per_publisher`. The outer query is `ORDER BY score DESC, o.id LIMIT limit`. Excluded rows never use a slot.
   - **Whole words, like `searchOffers`.** A word hits a text when the case-insensitive regex `'\m' || w || '\M'`
     matches it, so "art" does not match "start". The topics are checked with `EXISTS (SELECT 1 FROM
     unnest(a.topics) t WHERE t ~* ...)`. The score comes from a `LATERAL (SELECT SUM(...) FROM unnest($n::text[]) w)`
     subquery: 2 for a title or topic hit, 1 for an abstract-only hit, each word counted once.
   - Words reach SQL only as one bound `text[]` parameter, never interpolated. Each word passes the guard
     `^[\p{L}\p{N}]{3,40}$` (letters and digits, which carry no regex metacharacters). Any other word is dropped
     before the query.
   - Case folding is guaranteed for ASCII only, and a test pins this. A non-ASCII word still matches the same
     spelling.
   - Caps: `words` 1..12 (empty answers `[]`), `per_publisher` 1..50, `limit` 1..500. Price is not ordered on,
     because it lives in the `options` JSON and the fit ranker already judges budget.
2. **CAT-1.2 Candidates.** `candidatesFor` builds its words in this order:
   1. `needWords(terms.join(' '))`;
   2. then `needWords(need)`;
   3. deduped, each word cut to at most 40 characters, the list cut to 12.

   It calls the new read with `per_publisher: 10, limit: 50` for each corridor it already considers. The
   ceiling-currency rules stay as they are. The union is deduped by offer id first, then sorted by score and offer
   id, then capped at 10 per publisher, then cut to 50. When the union is empty (a vague brief), it falls back to
   today's `listAuthorisedOffers` path exactly. Existing tests keep passing, and vague briefs keep today's
   candidates.
3. **CAT-1.3 Spread the answer, never shrink it.** After the AI-5 filter (candidate ids only, no duplicates), the
   picks are walked in the model's order. The first 3 per publisher are kept, and the rest are held back. Free slots
   up to 5 are then filled with the held-back picks, in the model's order. One publisher with 5 picks still gives 5
   items; 5 picks from P1 plus 2 from P2 give 3 P1 + 2 P2. `sanitiseModelOutput`, `startFromOffer` and `rankFit`
   are unchanged.

## Inputs and outputs

- New: `domain/catalogue/src/read-matching.state.test.ts`, `domain/discovery/src/discover.fair.state.test.ts`,
  `domain/discovery/src/discover.fair.adversarial.test.ts`. Fixtures live inline in these files (a seeding helper in
  the test file); `domain/discovery/src/support.ts` is not changed.
- Changed: `domain/catalogue/src/read.ts`, `domain/catalogue/src/index.ts` (export),
  `domain/discovery/src/discover.ts`. The stale comment "The newest list is capped" is corrected.
  `docs/decision-log.md`: one row (the next free D number, D-122 after renumbering; D-121 went to DOM-1) for CAT-1 recording match-first candidates, 10 per publisher among the 50
  candidates, and 3 per publisher in the 5 items with back-fill.

## Acceptance tests (commit 1 holds only these tests and their fixtures, run red)

- `corepack pnpm vitest run domain/catalogue/src/read-matching.state.test.ts`: CAT-1.1 cases pass. Cases: guards
  are identical to `listAuthorisedOffers` (unauthorised, superseded, inactive publisher, other corridor all
  excluded); score order; the per-publisher cap; the limit; empty words gives `[]`; word caps.
- `corepack pnpm vitest run domain/discovery/src/discover.fair.state.test.ts`: CAT-1.2 and CAT-1.3. Fixture:
  1,000 photo offers from publisher P1 with topic `harbour`, plus 20 offers from P2..P5, of which 8 match
  "harbour at sunset". The model given to discover is a scripted port that records its input. Expected: all 8
  matching P2..P5 offers are among the candidates; at most 10 candidates are P1's; a scripted model that picks
  5 P1 offers and 2 P2 offers yields 3 P1 + 2 P2; a scripted model that picks 5 offers of one publisher in a
  one-publisher world yields 5 items; a brief with no matching word gets today's candidates (same ids as
  `listAuthorisedOffers`).
- `corepack pnpm vitest run domain/discovery/src/discover.fair.adversarial.test.ts`: keyword stuffing (one
  publisher's offers carry 20 topics covering every brief word) still keeps at most 10 of its offers among the
  candidates; words containing `%`, `_`, `'`, `\`, `.*` or `);--` neither error nor widen the match; one
  2,000-character word is cut to 40 characters; a 2,000-character need still gives at most 12 words and one model
  call; the same offer reached through two corridors counts once and uses one slot; a superseded or unauthorised P2
  version does not use one of P2's 10 slots; "art" does not match "start"; the ASCII case pin ("HARBOUR" matches
  "harbour").
- `corepack pnpm vitest run domain/discovery domain/catalogue`: every existing test still passes unchanged.
- `corepack pnpm test` (all six suites, which covers `apps/web` callers of discover such as `web.state.test.ts`,
  `buyer-display*.test.ts`, `scope-a.adversarial.test.ts`): green.
- `node scripts/mutation-checks.mjs --require-targets --timeout 400 --targets domain/discovery/src/discover.ts,domain/catalogue/src/read.ts --test-cmd "corepack pnpm vitest run domain/discovery/src/discover.state.test.ts domain/discovery/src/discover.adversarial.test.ts domain/discovery/src/discover.ceiling-fx.state.test.ts domain/discovery/src/discover.fair.state.test.ts domain/discovery/src/discover.fair.adversarial.test.ts domain/catalogue/src/read-matching.state.test.ts"`:
  at least 80 percent killed. Amended after the gate (10 Nov 2026): the whole-folder test command takes about 6 minutes per mutant, so the command names the six discover and read-matching test files instead.
- `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm check:isolation`, `corepack pnpm
  check:no-live-host`, `corepack pnpm check:secrets-names`: exit 0.

## Do not

Touch other packages or contracts; change the model prompt or call the model more than once per request; add a
dependency; read `process.env`; use `Date.now()`, `new Date()` without an argument or `Math.random()`; edit an
existing test (if one contradicts this spec, stop and report).

Evidence for the PR: the red run, the green run, the mutation summary, `git diff --stat`.
Commit: `test(discovery): fair candidates after a bulk import, red (CAT-1)`, then
`feat(discovery): match-first candidates with a per-publisher cap (CAT-1)`.
