# CAT-2: collections, duplicates and buyer demand

Task: 1,000 imported photos show up to buyers as a few named collections; exact duplicates collapse; what many
buyers ask for decides what is shown first, to buyers and to publishers, without exposing any one buyer.
Package: `domain/discovery`, `domain/catalogue` (CAT-1 read only), `packages/contracts` (additive), `apps/web`.
Owner: Vikram. Reviewer: Opus gate. Lane id: CAT-2. Linear: UNI-142. Builds on CAT-1 (branch from the CAT-1
branch). No migration: every column exists. No new dependency. No model call. No PayPal call, credential or row.

## Goal

1. **CAT-2.1 Collections.**
   - **Pure part.** `collectionsOf(rows, topicCounts)` in `domain/discovery/src/collections.ts`. Each row is
     `{ offer_id, publisher_id, topics, mime }`. `topicCounts` maps a publisher and a topic to a count.
     Topics are lower-cased and trimmed.
   - **An offer's collection** is the topic, among the offer's own topics, with the highest count in its publisher's
     `topicCounts`. Ties go to the topic that sorts first by code unit. An offer with no topic goes to `other`.
   - **The answer per offer** is `{ name, size, cover_offer_id }`, where `size` is that topic's count. For `other`, `size` is the
     number of the publisher's offers with no topic.
   - **The cover** is chosen among the given rows (the candidates): the offer of that collection with the smallest id by code unit, the same comparison
     `discover.ts` uses. Among offers whose mime starts with `image/`, the smallest one wins. When none of them is an
     image, the smallest overall wins. Input order never changes the answer.
   - **SQL part.** `collectionFacts(db, publisher_ids, offer_ids)` runs two queries, both under the CAT-1 guards:
     - `topicCounts`: `GROUP BY o.publisher_id, lower(trim(t))` over `unnest(a.topics)`, counted over ALL of a
       publisher's current authorised offers, not just the 50 candidates;
     - per-offer `mime` and `topics` from `articles`.
2. **CAT-2.2 Duplicates, before the cap.** CAT-1's `listAuthorisedOffersMatching` (`domain/catalogue/src/read.ts`)
   gains `DISTINCT ON (o.publisher_id, a.sha256) ... ORDER BY o.publisher_id, a.sha256, o.id` inside the guarded CTE,
   BEFORE `ROW_NUMBER`. So 10 copies of one photo take one slot. Each row also returns `duplicates_hidden`: the count
   of that publisher's other current authorised offers with the same `sha256`. The proposal item carries
   `duplicates_hidden` only when it is above 0.
3. **CAT-2.3 Collection on proposals, never shrinking the answer.** Each item gets `collection: { name, size }`.
   The CAT-1.3 walk becomes:
   - first pass: keep a pick only when its publisher has fewer than 3 kept AND its collection has fewer than 2 kept;
   - back-fill: fill free slots up to 5 with the held-back picks, in the model's order.

   The CAT-1 test "one publisher with 5 picks gives 5 items" still holds unchanged.
   Designer decision: CAT-2.3 wins over CAT-1 on the cap. The CAT-1 test "5 picks from P1 then one each from P2..P5" now expects P1, P1, P2, P3, P4, because all of P1's photos are one collection (2 kept in the first pass).
4. **CAT-2.4 Contract (additive).** In `packages/contracts/src/v1.ts`, the strict items of `DiscoverResponseSchema`
   gain `collection: z.object({ name: z.string(), size: z.number().int().nonnegative() }).strict().optional()` and
   `duplicates_hidden: z.number().int().positive().optional()`. The collection object also carries `images: z.boolean()` (true when the collection cover is an image), an additive field accepted by the designer; the proposal card says photos for images and items otherwise. Run `corepack pnpm openapi:emit` to regenerate
   `docs/api/openapi-v1.json`. `apps/web/src/api-v1/buyer.ts` and `agent.ts` pass the fields through unchanged.
5. **CAT-2.5 Buyer demand (privacy first).** `demandTerms(db, { day, limit })` in
   `domain/discovery/src/demand.ts`. The caller passes `day` as a UTC date (`clock.now()` floored to 00:00 UTC).
   - **Window.** Briefs with `created_at` in `[day - 30 days, day)`, so counts change at most once a day. There is no
     rolling edge to difference against.
   - **Terms.** Only `jsonb_typeof(structured->'terms') = 'array'` and elements of type `string` are read. A term is
     lower-cased and trimmed, then DROPPED whole (never stripped) unless it matches `/^[\p{L}\p{N} ]{3,40}$/u`. This
     filter runs in TypeScript after the SQL read, because Postgres regex has no `\p`; distinct buyers are then counted
     in TypeScript too.
   - **Buyers.** Count distinct `buyer_id` per term. Leave out buyers whose `buyers.created_at` falls inside the
     window's last 7 days, which slows down fresh sock puppets.
   - **What surfaces.** Keep a term only when:
     - at least `MIN_BUYERS` buyers asked for it (exported constant 5; there is no parameter for it);
     - it whole-word matches (the CAT-1 regex) a topic of at least one current authorised offer of at least 2
       different publishers. A publisher's own made-up vocabulary, such as a person's name in one catalogue, can
       never surface.
   - **The answer.** `{ term, band }[]` with `band` one of `'5-9' | '10-49' | '50+'`. Never an exact count, and no
     buyer id, brief id or raw text. Ordered by band, high first, then by term. At most `limit` items (10).
   - **Per publisher.** `demandForPublisher(db, publisher_id, terms)` adds `matching`: how many of that publisher's
     current authorised offers have that topic.
   - **Cache.** Composition caches both answers in memory per `day`, so a `/discover` render does not scan `briefs`.
     There is no publisher-buyer account link in the schema, so there are no linked accounts to leave out. The gate
     re-checks this.
6. **CAT-2.6 Screens.**
   - `/discover` shows "Popular requests" chips above the form. Tapping one fills the request box. With no terms,
     the whole block, heading included, is absent.
   - Proposal cards read "From the <name> collection (<size> photos)" and, when present, "<n> copies hidden".
   - The publisher home shows a card "What buyers ask for", with up to 5 lines "<term>: <band> buyers asked; <n> of
     your offers match". When there are no terms it says "No requests from 5 or more buyers yet.".
   - The words live in a new `apps/web/src/lib/demand-copy.ts` (chips, card, proposal lines).
   - Screens reach the domain only through `@/composition`.
7. **CAT-2.7 Decision row.** `docs/decision-log.md` gets the next free D number after CAT-1's. It records:
   collections by topic, duplicate collapse, the 2-per-collection cap with back-fill, and buyer demand shown to
   publishers and buyers under the rules in item 5.

## Inputs and outputs

- New:
  - `domain/discovery/src/collections.ts`, `collections.test.ts`;
  - `domain/discovery/src/demand.ts`, `demand.state.test.ts`, `demand.adversarial.test.ts`;
  - `domain/discovery/src/discover.collections.state.test.ts`;
  - `apps/web/src/lib/demand-copy.ts`, `apps/web/src/demand-copy.golden.test.ts`, `apps/web/src/demand-view.state.test.ts`;
  - `apps/web/src/app/discover/PopularRequests.tsx`, `apps/web/src/app/publisher/DemandCard.tsx`;
  - `scripts/shots-cat2.mjs` (Playwright, light and dark, writes to the path given as its argument).
- Changed:
  - `domain/discovery/src/discover.ts`, `domain/discovery/src/index.ts`;
  - `domain/catalogue/src/read.ts`, `domain/catalogue/src/read-matching.state.test.ts` (new cases only, none edited);
  - `packages/contracts/src/v1.ts`, `docs/api/openapi-v1.json`;
  - `apps/web/composition.server.ts` (`demand.forBuyers`, `demand.forPublisher`, the per-day cache);
  - `apps/web/src/app/discover/page.tsx`, `DiscoverForm.tsx`, `apps/web/src/app/publisher/page.tsx`;
  - `docs/decision-log.md`.

## Acceptance tests (commit 1 is tests only, run red)

- `corepack pnpm vitest run domain/discovery/src/collections.test.ts`:
  - 1,000 photos with 6 topics give 6 collections plus `other`;
  - a shuffled input gives the same answer;
  - the cover rule (an image beats a smaller non-image id);
  - the tie rule;
  - only the offer's own topics are chosen.
- `corepack pnpm vitest run domain/catalogue/src/read-matching.state.test.ts domain/discovery/src/discover.collections.state.test.ts`:
  - 10 copies of one photo use one slot, and the item says `duplicates_hidden: 9`;
  - the size counts all 1,000 offers, not the 50 candidates;
  - picks A1..A5 (collection A, publisher P1) then B1..B3 (collection B, publisher P2) give A1, A2, B1, B2, then
    back-fill A3, in that order;
  - one collection only still gives 5 items;
  - every item carries its collection.
- `corepack pnpm vitest run domain/discovery/src/demand.state.test.ts domain/discovery/src/demand.adversarial.test.ts`:
  - 4 buyers: absent. 5 buyers: present with band `5-9`;
  - one buyer with 50 briefs counts once;
  - briefs outside `[day-30, day)` are ignored, and a brief created today changes nothing until tomorrow;
  - buyers created in the last 7 days do not count;
  - a term in only one publisher's topics never surfaces (the "jane doe" attack: 1 offer plus 5 buyers);
  - `john@x.com` is dropped, not stripped;
  - a non-array `terms` and non-string elements are skipped;
  - the JSON answer has only the keys `term` and `band`, no `buy_`/`brf_` id and no raw text.
- `corepack pnpm vitest run apps/web/src/demand-copy.golden.test.ts apps/web/src/demand-view.state.test.ts`:
  - the words;
  - an empty list renders no heading.
- `corepack pnpm test` (six suites), then `corepack pnpm check:openapi` and `corepack pnpm check:routes`: green.
- `node scripts/mutation-checks.mjs --require-targets --timeout 400 --targets domain/discovery/src/collections.ts,domain/discovery/src/demand.ts,domain/catalogue/src/read.ts --test-cmd "corepack pnpm vitest run domain/discovery/src/collections.test.ts domain/discovery/src/demand.state.test.ts domain/discovery/src/demand.adversarial.test.ts domain/catalogue/src/read-matching.state.test.ts"`:
  at least 80 percent killed.
- Static checks, exit 0: `corepack pnpm typecheck`, `lint`, `check:isolation`, `check:no-live-host`,
  `check:secrets-names`.
- Screenshots: `cd apps/web && corepack pnpm build && cd ../..`, then from the repo root `node scripts/shots-cat2.mjs
  /mnt/project-files/cat-smart/shots/`. The script starts `next start` for `apps/web` with `UMS_MODE=offline` and the
  offline seed, resolves `@playwright/test` from `apps/web`, seeds 5 buyers' briefs so chips show, and stops the server. This gives `/discover` (with chips and a proposal) and the publisher home,
  each in light and dark, against the offline seeded app.

## Do not

Add a migration or table; change or remove an existing contract field; call the model; show an exact count, a
term below 5 buyers, a single-publisher term, a buyer id or raw request text; touch PayPal, payments, approval,
transport or safety; edit an existing test.
