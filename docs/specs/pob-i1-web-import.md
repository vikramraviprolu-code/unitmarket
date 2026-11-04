# Spec: web import, from a publisher's web address to a published catalogue (POB-I1)

Task: a publisher gives a web address they control. UnitMarket reads items, pictures and prices into a staging list. The publisher picks
what to show, edits, and publishes. Published items become ordinary articles and offers with a hosted copy of the content.
Package: `packages/transport` (fetcher), `domain/catalogue` (domain proof, extract, stage, publish), `packages/db` (migration 0022), `packages/jobs`, `apps/web`
Owner: builder (Sonnet) Reviewer: Opus (fetcher and extraction, one round) Branch: `feat/pob-i1-web-import`
Commit: `feat(<package>): <what> (POB-I1)` Decision: D-089, journey steps J7 to J9. Base: the old FEED lane, branch `feat/feed-import` (commits 5ad91a7, 59b26f2).

Start: branch from main, then bring in the FEED files with `git checkout feat/feed-import -- <paths>` (guard `feed-guard.ts`, fetcher `feed-fetch.ts`, parser
`feed-parse.ts`, importer `feed.ts`, their tests and the spec `docs/specs/feed-import-guards.md`) and adapt. Keep every refusal rule of that spec.

Changes from the FEED spec (owner rules of D-089):

- Allow list: not `UMS_FEED_HOSTS`. A host is allowed only if it is the publisher's verified domain (table `publisher_domains`: publisher_id, host,
  token_hash, state `pending` or `verified`, verified_at). The address checks stay (public addresses only, 169.254.169.254 and every private range refused,
  resolve once and pin, https and 443 only, no redirects, size and time caps). No deploy is needed for a new publisher.
- Domain proof: the publisher adds a token to a `<meta name="unitmarket-verify" content="...">` tag on the front page, or serves it at
  `/.well-known/unitmarket-verify.txt`. A single guarded GET of those two fixed paths on a public host checks it; nothing else is fetched from an unverified host.
- Reading a source (A1): the page or feed is fetched through the guard. Extraction is deterministic and hand written: schema.org JSON-LD (Product, Article,
  ItemList), OpenGraph tags, RSS, Atom, JSON feed, and links from a sitemap to item pages on the same host. Text is stripped as in FEED (no HTML, no links followed
  blindly, no script). No AI. A source with no structured data gives zero items and a plain reason. At most 100 items, 2 MB each.
- Content copy (D-089 item 5): for an article, the extracted text is stored as the hosted copy with its sha256 in the existing content table; for an image item, the
  image is fetched through the same guard (content type image/jpeg, png or webp, 2 MB cap, no redirect) and stored with its hash. The item's own page is the only
  content link fetched, same host only. Nothing is hotlinked.
- Staging: migration 0022 adds `import_batches` (publisher, source host, state, counts, created_at) and `import_items` (batch, source key, title, summary, price_minor,
  currency, image_ref, content_ref, state `staged`, `hidden`, `published`, `refused` with reason). Nothing reaches the catalogue from staging without the publisher's action.
- Review screen (publisher): list, pick and hide, edit title and the publisher's own price, see the buyer price that will show (publisher price plus fee through the
  injected `FeePolicy` port; the default policy is fee 0 until POB-M1 lands; do not import M1 code). Currency is the publisher's country corridor currency.
- Publish: one transaction per item through the existing publisher offer path (attestation of rights is required once per batch), creating article, content blob,
  offer version 1 as live, an audit row. Re-import skips existing keys and never overwrites; a changed hash is counted.
- A background run through `packages/jobs` with progress (done, total, refused) so 100 items do not hold a request open. Routes: start import, status, review actions, publish.
- Tests use a scripted fetcher over fixtures (a fixture "shop" site with JSON-LD, one with RSS, one hostile, one with images). No test opens a socket.

Tests first (commit 1, run red): the FEED tests adapted (guard, fetch adversarial, parser, importer), plus `domain/catalogue/src/domain-proof.test.ts`, `extract-structured.test.ts`
(JSON-LD, OpenGraph, sitemap, RSS; hostile pages: script, huge, nested, entity bombs, off host links), `import-stage.state.test.ts`, `import-publish.state.test.ts` (fee port
used, price proposal bounds from the FEED spec, re-import skips), `packages/db/src/migration-0022.state.test.ts`, `apps/web/src/web-import.state.test.ts`, SSRF table incl. the
Cloud Run metadata address and a verified domain that resolves to a private address after verification (refused).

Acceptance (run, paste output): `corepack pnpm vitest run packages/transport domain/catalogue packages/db apps/web/src/web-import` pass, red run shown first; `check:routes
check:isolation check:no-live-host check:secrets-names check:hosting`, lint, typecheck, format check, six suites, one `@umsbx/web` build pass.
Do not: fetch from a host that is not the publisher's verified domain; follow a redirect; add a dependency (hand written parsers); call an AI model; run a real fetch; touch
payments, approval, ledger, transport files other than the fetcher and guard, or contracts beyond the new ports.
Evidence for the PR: outputs, red run, the refusal table, one staged batch from a fixture shop listed with prices.
