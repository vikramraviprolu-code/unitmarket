# Spec: in-app reader view with the time-left meter (READER-A)

Task: a reader page that shows a bought article inside the app, as text, with the window meter, instead of a raw text file.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus, access-clock and delivery evidence review
Branch: `feat/web-reader-a-view` Commit: `feat(web): <what> (READER-A)` Decisions: D-065 item 44; D-006 (access clock);
architecture 9.4, 9.6; P13, P14. Depends on: UX-1A merged (it edits the library pages and `WindowMeter.tsx`). Split out
of the requested `skin-b-harbour-motion-reader` so the delivery review stays separate. Common rules: plan section 2.

Goal: from the library a buyer opens "Read here" and reads the article in the app, with the time left shown by the existing
meter; the access evidence, rate limits and window rules are exactly those of the existing content route.

Behaviour:

- Page `apps/web/src/app/library/[entitlement]/read/page.tsx` (buyer only, else redirect to sign-in with `next`). Engine
  method `readerView({ entitlement_id, actor, session_id })` in composition: it calls the existing `issueLink` and `serve`
  with `mode: 'read'` (the same functions the `/c/[token]` route uses), reads the stream to the end on the server, and
  returns `{ title, publisher, option, window, paragraphs: string[] }` or a refusal with the same reasons the content route
  gives (window ended, refunded, not ready, not this buyer: 404). Only `text/plain` and `text/markdown` are rendered; any
  other mime answers "This item opens as a download." with the existing open button. Size cap 200 KB, else the same answer.
- Rendering: paragraphs split on blank lines, each a React text node inside `<p>`. No HTML, no Markdown rendering beyond
  paragraphs, never `dangerouslySetInnerHTML`; injection text in an article shows as text. Reading width 70ch; the
  `WindowMeter` at the top with the "Access until <date>" line from stored data; the label Sandbox or Dry run from stored data.
- Before building, confirm in `domain/delivery/src/serve.ts` and the content route when the delivery evidence is written
  (start of stream, end of stream or both). The reader must write the same evidence at the same points. If `serve` cannot be
  used this way without changing `domain/delivery`, stop and report (missing interface); do not change the domain.
- Library item page: add a "Read here" link for `online_read` items next to the existing open button (link only; the button
  and its download path stay). Copy in `apps/web/src/lib/reader-copy.ts`.
- Rate: the reader counts against the existing `content` limiter (60 per hour per actor) through the same `serve` call; if
  it does not, say so.

Tests first: `apps/web/src/reader.state.test.ts` (booted test app: a ready entitlement renders the article paragraphs; the
access events written equal those of one `/c/[token]` read for the same entitlement; ended window, refunded and other
buyer's entitlement refused with the content route's reasons); `apps/web/src/reader.adversarial.test.ts` (an article whose
text holds `<script>` and listing injection text from `packages/model/test-data/injection-cases.json` renders as text in the
page source; a publisher or anonymous session gets no content; a non-text mime returns the download answer);
`apps/web/src/reader-copy.golden.test.ts`.

Acceptance: `corepack pnpm test:state apps/web`, `corepack pnpm test:adversarial apps/web`, `corepack pnpm test:golden
apps/web`, `corepack pnpm check:routes` (no new route file), plan section 3; `corepack pnpm test:e2e` if it runs offline.
Do not: change `domain/delivery`, `domain/access-clock`, `domain/entitlements`, the `/c/[token]` route or the access policy;
add a Markdown library or any dependency; animate the meter or any figure; edit `globals.css` beyond one `.reader` block
(70ch, line height), and only if SKIN-A has merged; otherwise use existing classes.
Evidence: outputs, red run, the evidence comparison (events from the reader and from the route), screenshot at 400 px, cost line.
