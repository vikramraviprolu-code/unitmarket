# Entry paths without a PHP plugin: decision memo (31 Oct 2026)

Status: research only, no code changed. Asked by the owner (Sakthi) after WordPress (MVP-E) was put on hold (overnight
assumption 35). Inputs: `docs/design/mvp-plan.md` MVP-E, the three MVP-E branches, `apps/web/src/lib/page-headers.ts`, decisions
D-005, D-064, D-065, D-066 and items 48, 70 and 71 in `docs/owner/DECISIONS-FOR-VIKRAM.md`. Web facts were read on 30 Oct 2026;
anything not read from a primary source is marked UNVERIFIED.

## Recommendation

Keep the product idea (a publisher's own page offers "Buy through UnitMarket" for one article; checkout and rights stay with us)
and drop PHP from the judged path. Build three small things, in this order:

1. An `/enter` route that verifies the E-L1 signed link and opens the same approval screen as `/o/<publisher>/<offer>`.
2. A demo publisher page inside the app (a fictional brand such as the seeded `harbour-ledger`), rendered by our server, which
   signs a fresh link on every render with a key that never leaves the server. This is the plan's own cut rule for MVP-E
   ("keep a static publisher page inside the app using the same signed link") and it is the whole judged journey.
3. A "Share this offer" panel in the publisher console: a copy button for the offer link and a plain HTML snippet (one `<a>`
   element, no script) that any CMS accepts, plus Open Graph tags on the offer page so a pasted link becomes a preview card.

Feed import (E-L2) and the WordPress plugin (E-L3) stay on their branches as optional extras after 9 Nov. A script widget,
an oEmbed iframe card, Zapier and a headless CMS are not worth it before the deadline.

## What is built and reusable (checked 31 Oct, read only)

| Branch (pushed)                        | State                                                                                                                                                                                       | Run here                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `feat/offer-entry-signed-link` 411e2eb | `signOfferLink`, `verifyOfferLink`, `offerRefFromLink` in `domain/offer-entry`; HMAC-SHA256, constant time compare, 24 hour lifetime cap, price names refused. No route, no key storage. | `vitest run domain/offer-entry`: 6 files, 84 tests pass. Lint, typecheck and gates not run; not reviewed. |
| `feat/feed-import` 59b26f2             | SSRF guard and pinned fetcher in `packages/transport`, strict RSS, Atom and JSON Feed parser, importer that writes drafts only, E-04 injection re-run. Config, composition and route half done. | Feed tests in transport, catalogue and discovery: 6 files, 483 tests pass. Typecheck and web tests not run. |
| `feat/wordpress-plugin` e2bdf7c        | Shortcode plugin `integrations/wordpress/unitmarket-buy-button/`, PHP signer, settings page, cross-language test vectors and a TypeScript contract test.                                      | `php tests/run.php`: 253 passed, ALL PASSED. No real WordPress run.                                         |

Two findings in the plugin matter for any WordPress path. First, the plugin signs at page render with a 60 minute lifetime, so a
page cache or CDN in front of WordPress will serve expired links. Second, the link has no `target`, so inside an iframe (WordPress
Playground runs WordPress in one) the click would load our app in the frame, and our CSP `frame-ancestors 'none'` refuses that.
Both are fixable, but they show that the plugin is not finished until it runs in a real WordPress.

## Options compared

Effort is in lane-days for this team, including one Opus review. Testability means testable in THIS environment (Node, PHP
CLI only, no WordPress, no outbound network for builders).

| #   | Option                                                                         | Effort         | Security risk                                                         | Testable here                                 | Demo value                          | Hosting and third parties                                          |
| --- | ------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| 3   | Demo publisher page in the app, signed per render                              | 0.5 to 0.75    | Low: key stays on our server, same origin, our CSP unchanged          | Fully (unit, state, Playwright)               | High: the whole journey in one take | None beyond our host                                               |
| 1   | Console link builder: copy link, copy `<a>` snippet, Open Graph tags           | 0.5 to 1       | Low: no script on the publisher's site; output escaped                | Fully                                         | Medium to high                      | None; publisher pastes into any CMS                                |
| 4   | Feed import only (finish E-L2), or upload or paste a feed file with no fetch   | 0.5 to 1       | Fetch: medium (SSRF, guarded). Upload: low (no network at all)        | Fully with fixtures                           | Medium: onboarding plus AI safety   | Fetch needs an owner host allow-list; upload needs none            |
| 2   | Script widget or web component served by us, oEmbed card                       | 1 to 2         | Medium to high: our script runs on publishers' pages; iframe needs a CSP exception | Partly (no real host CSP)           | Medium                              | Host must allow our script; Substack and Medium run no scripts     |
| 6   | Minimal plugin plus WordPress Playground                                        | 1 to 1.5 more  | Medium: every publisher holds a shared HMAC key                       | PHP harness only; Playground not runnable here | Medium to high, recognisable       | playground.wordpress.net, public repo first; third-party trademark |
| 7   | Headless CMS or Markdown publisher feed                                        | Markdown 0.25 on top of 4; CMS 1 to 2 | Markdown low; CMS adds accounts and keys                      | Markdown fully; CMS no                        | Low                                 | CMS: account, terms, API key                                       |
| 5   | Zapier, Make, n8n webhook publish flow                                          | 1 to 1.5       | Medium: new inbound webhook, another secret, third-party data flow    | No                                            | Low                                 | Paid plan for webhooks; account; terms                             |

### Notes per option

1. Link builder. The E-L1 cap of 24 hours means a signed link pasted into a CMS dies the next day. Two honest ways out: (a) the
   snippet uses the existing public URL `/o/<publisher>/<offer>`, because the price always comes from our catalogue and the
   signature protects no money; or (b) long lived signed links with a key version, where rotating the key is the revocation.
   (b) changes the E-L1 spec and adds key management, so it is an owner question. Output must be escaped HTML built on the
   server from catalogue data; the snippet never carries a price. Reach (from vendor docs and forums): WordPress Custom HTML
   block, Ghost HTML card, Webflow and Squarespace code blocks accept an `<a>`; Substack has a "Custom button" with a label and
   URL (UNVERIFIED, from a third-party help page); Medium runs no scripts or embed code and turns a pasted link into an Embedly
   card or a plain preview (Medium help centre). Open Graph tags on the offer page give preview cards almost everywhere (Ghost
   bookmark card, Substack, Medium, chat apps; UNVERIFIED per platform).
2. Script widget. Our own CSP is not the obstacle (it governs our pages only); the publisher's CSP is. WordPress lets only users
   with `unfiltered_html` save script (administrators on a single site, super admins on multisite; third-party sources);
   Ghost HTML cards accept script per community forum posts (UNVERIFIED officially) but scripts never run in Ghost emails; Medium
   and Substack run none. A script we serve becomes a supply chain risk for every publisher (needs a versioned immutable URL and
   SRI, and CORS if it fetches). An oEmbed `rich` card must be an iframe; WordPress filters untrusted providers to an iframe with
   `sandbox="allow-scripts"` (developer.wordpress.org reference for `wp_filter_oembed_result`), which blocks top navigation, so
   the button only works through the `wp-embed` postMessage protocol that had an XSS fix in WordPress 6.2.1 (Securitum write-up).
   It would also need a second CSP with a relaxed `frame-ancestors` for one route. Not before the deadline.
3. Demo publisher page. A fictional brand rendered by our app, visibly labelled as a demo publisher page. It can sign with a key
   held in server configuration (a new name in `packages/config`, the value set by a human) or with a random key made at boot
   through `packages/runtime`, which needs no secret at all. The boot key works with max instances 1 (hosting.md) but breaks
   links during a deploy overlap, so the page must show a clear "reload" refusal. It avoids third-party logos, which matters
   because the rules summary forbids third-party trademarks in the video (DECISIONS-FOR-VIKRAM.md header).
4. Feed import. The E-L2 guards (https only, owner allow-list, one pinned DNS answer, no redirects, 2 MB, 5 s) are the strongest
   code on the MVP-E branches. A fetch is outbound traffic that the owner must approve by listing hosts. An upload or paste of a
   feed file reuses the parser and importer, has no SSRF surface, and is the safer first step. Imported items stay drafts until
   the publisher authorises them, and E-04 shows the AI guard on hostile text, which supports the AI criterion.
5. Integration platforms. Primary source: the PayPal developer blog post for the hackathon lists APIMatic, Render, Kernel,
   Channel3, Postman, Astropods, Elastic, AG Grid and Bryntum, with sponsor prizes only for AG Grid, APIMatic, Bryntum,
   Channel3 and Render. It does not name Zapier, and the repository has no mention of Zapier. Some aggregator listings name
   Zapier as a sponsor tool (UNVERIFIED). Webhooks by Zapier is a premium app not on the free plan (third-party pricing pages,
   UNVERIFIED). n8n is source available under its own licence (UNVERIFIED). No prize, a paid account, and nothing a judge can run
   from the repo: skip.
6. Plugin plus Playground. WordPress Playground is GPL-2.0 (GitHub repository). A blueprint can install a plugin from a
   `git:directory` resource or from a `url` that sends CORS headers (Playground resource docs), so it needs the repository to be
   public first, which is a human step. Data is lost on refresh unless storage is on; WASM downloads of 15 to 30 MB and 10 to 20 s
   loads with a small plugin (Playground limitations page). The blueprint `features.networking` flag exists; the default is
   documented as true on one page while another says networking is off by default (conflict, UNVERIFIED). The local CLI
   `@wp-playground/cli` is a new dependency (D-008) and downloads WordPress at run time, so it cannot run here. A demo needs the
   signing key typed into Playground or put into a blueprint, which publishes a key; that key must then sign only demo offers.
   The plugin is GPL-2.0-or-later inside an Apache-2.0 repository, which the README and notices must state.
7. Markdown or headless CMS. A folder of Markdown or a JSON Feed file is just a fixture for option 4. A hosted headless CMS
   adds an account, terms and a key for no judged benefit.

## Fit with the five criteria

Technological Implementation: options 3 and 1 show the signed link refusing a changed byte, an expired link and a price
parameter (E-01) on screen, end to end with the PayPal sandbox; option 4 adds SSRF and injection evidence. Design: one coherent
journey from a publisher page to a receipt, with no third-party chrome. Potential Impact: the snippet works on any CMS, which
is a wider claim than one WordPress plugin, and we can say so honestly. Innovation: per-article purchase from the publisher's
own page with rights kept by the platform. Presentation: the in-app demo page films cleanly in under 3 minutes with no third-party
trademark and no live third-party site that can fail during judging (1 to 15 Dec).

## Phased plan

Tonight (31 Oct), about 1 lane-day: review and merge E-L1 after its gates (lint, typecheck, format, isolation, secrets-names,
no-live-host; it only needed the final run); spec and build the `/enter` route (verify, then the same approval screen as `/o/`,
refusals as plain pages) with state and adversarial tests for E-01.

Before 9 Nov, about 1.5 lane-days: the demo publisher page (option 3) with a Playwright journey; the "Share this offer" panel and
Open Graph tags (option 1) using the plain `/o/` URL unless the owners choose long lived signed links; README and video script
lines that say what is real (sandbox payment) and what is a demo (the publisher page is ours, fictional).

After 9 Nov, only if all green and before 11 Nov: feed import by upload or paste, or by fetch with an owner allow-list
(finish E-L2 wiring); the plugin and a Playground blueprint as a README appendix after the repository is public, not in the video.

Not planned: script widget, oEmbed card, Zapier, Make, n8n, headless CMS.

## What to salvage

E-L1: all of it; it is the core of options 1 and 3. E-L2: the transport guard and fetcher, the parser, the importer and the
E-04 test as they are; finish config and route only if option 4 goes ahead. E-L3: keep the branch and the cross-language vectors
(the vectors also pin the TypeScript signer); fix `target` and the caching note before any real WordPress run. E-L4 becomes option 3.

## Human only

Choosing the fictional brand and approving its text and images; setting any signing key value on the host; making the
repository public (needed for Playground); any WordPress host, account or Playground session shown to judges; recording the
video; re-checking the rules and the sponsor list on 5 and 11 Nov; any Zapier or CMS account. No agent creates accounts or holds
credentials.

## Questions for the owners

1. Do you accept the in-app demo publisher page as the judged entry path, with WordPress as an optional appendix?
2. For pasted snippets: plain public offer URL (no signature, attribution untrusted), or long lived signed links with key
   versions (changes the E-L1 24 hour cap)?
3. Demo page key: a random key made at boot (no secret, links break during a deploy), or a configured key that a human sets?
4. Which `source` value should a snippet or demo page record: reuse `wordpress`, or add a new value (a contract change)?
5. Feed import: upload or paste only, or also fetch from hosts you list? Before 9 Nov or after?
6. May the plugin, under GPL-2.0-or-later, stay in an Apache-2.0 repository, or should it be cut?
