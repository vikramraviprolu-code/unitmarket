# Spec: article facts on the offer pages (PUB-E5)

Task: show read-only article facts on the publisher offer list (S2), the publisher offer page (S3) and the buyer offer page.
Package: `domain/catalogue` (read only), `apps/web` Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/pub-e5` Commit: `type(<package>): <what> (PUB-E5)` Closes traceability row P-D1; proposal 3D. Decisions: D-041, D-051.

Goal: a publisher sees what is on sale without leaving the offer pages: title, abstract, language, size in KB and the
first 12 characters of the content sha256 under the label "Content fingerprint". A buyer sees title, abstract, language
and size (no hash). Nothing is editable. Delivery, seed content, prices and offer status rules are unchanged.

Behaviour:

- Data: the `articles` row joined by the offer (`title, abstract, language, bytes, sha256`). `listOwnOffers` and
  `getOwnOffer` add `article_abstract`, `article_language`, `article_bytes`, `article_sha256` to the existing select; the
  `WHERE o.publisher_id = $1` filter stays the only scope, taken from the session actor, never from a client id.
  The buyer page takes `language` from the existing offer read and `bytes` from one extra `articles` read keyed by the
  offer's own article id (`composition.server.ts`, `offerPageOf`; the `OfferPage` view gains `language` and `bytes`, so the one test fixture that builds it, `ui/ux-phase1a-addendum.test.ts`, gains the two fields). No migration, no contract change.
- Copy in `lib/offer-copy.ts` (no italics, no dashes): labels Abstract, Language, Size, Content fingerprint; size as KB
  with one decimal (12.4 KB); language as a word for en, fr, de, es, otherwise the stored code; fingerprint is the first 12
  characters of a 64 character lowercase hex sha256. Any missing, blank or malformed fact reads "Not recorded".
- S2: under each title, the abstract and one line "Language English. Size 12.4 KB. Content fingerprint a1b2c3d4e5f6." S3: an
  "About this article" card (`dl`) with the four facts and a note that they cannot be changed here. Buyer page: one line
  "Language English. Size 12.4 KB." under the abstract. Existing classes only; `globals.css` untouched; no inline style.
- Withdrawn, draft and suspended-publisher behaviour is unchanged: the same notices, `on_sale` flag and form rules; the
  facts show beside them.

Tests first (commit 1, run red): `domain/catalogue/src/article-facts.adversarial.test.ts` (publisher A never gets B's
article facts from list or get, a guessed B offer id is null, non-publishers get null, withdrawn offers keep their own
facts), `apps/web/src/article-facts.adversarial.test.ts` (engine and revise route bodies for A hold no fact of B; the
buyer offer page view carries no sha256), `apps/web/src/article-facts-copy.golden.test.ts` with
`apps/web/src/golden/article-facts-copy.golden.txt` (copy, size rounding, missing-row fallback).

Acceptance (all pass):

- `corepack pnpm test:adversarial domain/catalogue apps/web` (new files green)
- `corepack pnpm test:golden apps/web` (new golden green, `offer-copy.golden.txt` unchanged)
- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format`, `corepack pnpm check:isolation`
- `corepack pnpm --filter @umsbx/web build`

Do not: edit `globals.css`, migrations, contracts, the delivery route or any write path; add a dependency; send a client id.
Evidence: red run, outputs, cost line.
