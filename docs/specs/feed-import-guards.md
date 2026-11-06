# Spec: publisher offer feed import, safe by construction (FEED, MVP-E lane E-L2)

Task: let an operator import a publisher's offer feed (JSON, Atom or RSS) as DRAFT articles and offers, with no way to
reach a private address, follow a redirect, or run feed text. Off by default.
Package: `packages/transport` (guard, fetcher), `domain/catalogue` (parse, import), `packages/config`, `apps/web` (one
route) Owner: builder (Sonnet) Reviewer: Opus, one round
Branch: `feat/feed-import` Commit: `type(<package>): <what> (FEED)` Rules: mvp-plan MVP-E E-02, E-03, E-04; nfr SOP 16, 18, P19;
architecture S2 (only `packages/transport` opens a connection).

Goal: with `UMS_FEED_HOSTS` unset (the default) the feature is off: the real fetcher is never built and no code path can
open a connection. With one or more allow-listed hosts, an operator with the second factor can import one feed URL; every
refusal below ends before any byte is stored, and what is stored is plain text, hashed, in draft state.

Behaviour:

- Config `UMS_FEED_HOSTS` (CFG-0 pattern): comma list of exact lower-case host names (no IP, no wildcard, no port, at most 8),
  default empty. A bad entry refuses boot naming the variable. Names only in `.env.example`; not in the hosting blueprint.
- `packages/transport/src/feed-guard.ts` (pure): URL check (https only; no userinfo; port 443 only; no IP literal in any
  encoding, decimal, octal, hex, short, IPv6, IPv4-mapped; host must equal an allow-list entry; no control characters; at
  most 2048 characters), address check (loopback, unspecified, link-local incl. 169.254.169.254, private 10/8 172.16/12
  192.168/16, CGNAT 100.64/10, multicast, reserved, documentation, benchmarking, IPv6 ::1, fc00::/7, fe80::/10, ff00::/8,
  IPv4-mapped and NAT64 forms, 6to4 and Teredo), response head check (3xx is a refusal, status must be 200, content type
  JSON, Atom, RSS or XML, no content encoding, declared size at most 2 MB).
- `packages/transport/src/feed-fetch.ts`: the one real fetcher. Resolve once, refuse if ANY resolved address is non-public,
  connect to the pinned address with the host as SNI and Host, check the connected socket address equals the pin, never
  follow a redirect, stop at 2 MB, 5 s for the whole exchange (name lookup included). Errors carry a fixed kind only.
- `domain/catalogue/src/feed-parse.ts`: strict parser written by hand, no dependency. JSON `{ "items": [...] }`; Atom and RSS
  through a small XML reader that refuses DOCTYPE, ENTITY and processing instructions, and caps depth, nodes and entity
  expansion. At most 100 items. Field caps (id 200, title 200, abstract 600, body 20000 characters, 8 topics of 40).
  Text is tag-stripped (script and style bodies dropped), entities decoded once and stripped again, control and invisible
  characters removed, `<` and `>` removed; nothing is ever treated as HTML, a link or an instruction.
- `domain/catalogue/src/feed.ts` `importFeed`: operator with second factor; publisher must exist and be `active`. One
  transaction: article (`created_by` = `feed_import:<operator>`, `sha256` of the body recorded, content blob), one DRAFT
  offer version 1 (never an authorisation row, never listed: `listAuthorisedOffers` reads authorised only), one audit row.
  An item whose key exists is skipped and never overwritten (a changed hash is counted, not written). PRICE RULE: a feed
  price is a proposal only; it is used for the draft `online_read` option only when an integer from 1 to `offer_max_minor`,
  otherwise the article is stored with no offer ("price needed"). Either way the publisher must authorise the draft
  (follow-up: no draft-authorise path exists yet, `reviseOffer` needs a live offer). Links in the feed are never fetched.
- Engine method `feedImport`, route `POST /api/ops/feed-import` (operator, second factor, CSRF, `.strict()` body of
  `publisher_id`, `feed_url`, `reason`, 1 KB, rate 6 per hour per actor, risk high), audit row for an accepted and for a
  refused attempt. Answers `feed_off` before any resolution when the allow-list is empty; honours the outbound kill switch.

Tests first (commit 1, run red): `packages/transport/src/feed-guard.test.ts`, `feed-fetch.adversarial.test.ts` (E-02, fake
DNS and fake request, table driven, plus a stress table), `packages/config/src/feed-hosts.test.ts`,
`domain/catalogue/src/feed-parse.test.ts`, `feed.state.test.ts`, `feed.adversarial.test.ts` (E-03),
`domain/discovery/src/feed-injection.adversarial.test.ts` (E-04: the AI-1 set over imported text, scripted model),
`apps/web/src/feed-import.state.test.ts`. No test opens a socket.

Acceptance (run, paste output):

- `corepack pnpm test:unit packages/transport packages/config domain/catalogue`: all pass.
- `corepack pnpm test:adversarial packages/transport domain/catalogue domain/discovery apps/web`: E-02, E-03, E-04 pass.
- `corepack pnpm test:state domain/catalogue apps/web`: pass (route, off by default, rate limit, audit).
- `corepack pnpm check:routes check:isolation check:no-live-host check:secrets-names check:hosting`: pass.
- Common list: lint, typecheck, format check, six suites, one `@umsbx/web` build.

Do not: add a dependency; read a feed link; follow a redirect; put a price from the feed into a live offer; touch payments,
approval, ledger, migrations or contracts; run a real feed import.
Egress added: `feed-fetch.ts` only, GET to allow-listed hosts on 443 when an operator triggers it. Zero by default.
