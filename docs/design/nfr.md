# UnitMarket Sandbox Track: Non-Functional Requirements and Security Standards

Status: **BASELINE v1.0** for Vikram (owner) and Sakthi (reviewer), 21 Oct 2026, consistent with `architecture.md` v1.0 and `mvp-plan.md` v1.0 (owner decisions D-1 to D-9 recorded there: separate repository, no PayPal connection without explicit owner approval, Claude API not approved, so the scripted model runs and every Claude item below applies only after a separate approval). Scope: the PayPal SANDBOX track only. The simulation track is untouched and shares nothing with this track: no code, contracts, tests, CI workflow, lockfile or artifacts.

Fixed inputs (already adopted, restated so every requirement below can cite them):

- M1 Access only after a confirmed capture AND a separate read-back whose amount, currency, payee and reference match the approval snapshot.
- M2 A 15-minute approval window, separate from a 24-hour abandonment window.
- M3 No automatic second charge, ever.
- M4 Secrets server-side only.
- M5 Live mode disabled, fail-closed.
- M6 The `Dry run` and `Sandbox` labels come from the stored `environment` value (`dryrun` or `sandbox`), never from build flags or copy.
- Scope: US and USD first; no Payouts; PGlite first, Supabase later; optional WordPress entry later; online 24x7 from first hosted deploy to 15 Dec 2026; entry submitted by 9 Nov 2026.

Sources checked for this document (official, read 21 Oct 2026): PayPal Idempotency reference, PayPal Rate limiting guidelines, PayPal Integrate webhooks guide, PCI SSC blog on SAQ A changes, PGlite API docs. Anything else is marked UNVERIFIED.

Facts taken from those sources:

- PayPal stores `PayPal-Request-Id` for a period that differs per API. A repeat returns the latest status of the first request. Two simultaneous requests with the same id may fail the second.
- PayPal publishes no rate limit. It answers 429 `RATE_LIMIT_REACHED` to traffic it judges abusive, advises webhooks over polling, and advises caching OAuth tokens.
- Webhook verification signs `transmissionId|timeStamp|webhookId|crc32(raw body)` with the certificate at `paypal-cert-url`. The postback endpoint `verify-webhook-signature` is the alternative. Mock events from the simulator cannot use postback. PayPal retries a failed delivery up to 25 times over 3 days.
- SAQ A no longer lists requirements 6.4.3 and 11.6.1. It adds an eligibility criterion: the merchant confirms its site is not susceptible to script attacks that could affect its e-commerce systems.
- A PGlite `dumpDataDir` tarball loads only back into PGlite; it is not a portable Postgres backup.

## 1. SOP adaptation

The SOP assumes three things this project lacks. First, Context7 MCP: we use `pnpm outdated`, the npm registry and official changelogs instead. Second, Supabase RLS everywhere: PGlite runs inside the app process, so the app is the only database client, and RLS would add no boundary while the app role owns every table. Third, a password and MFA user base: we store no passwords. The SOP prompts are not run as written; each section becomes the checks below, reported PASS, FAIL or WARNING in the gate report (section 1.3).

### 1.1 Section by section

| SOP section | Applies (what we check) | Not applicable, and why | Added for this payments marketplace | Gate |
|---|---|---|---|---|
| 1 Package currency | Inventory of every direct dependency with installed and latest stable version; update only outdated; read the breaking changes first | Context7 MCP absent: use `pnpm outdated` plus official changelogs | Dependency freeze on money paths from 2 Nov (7 days before submission) except security fixes; check Next.js security advisories at every gate, and never rely on middleware alone for authorisation (CVE-2025-29927 class) | A, F |
| 2 Secrets | Every secret listed; none in a client bundle; no client prefix on a secret; secret-bearing calls server-only | SBX uses a full redirect to the PayPal approval page, not the JS SDK, so no PayPal name uses `NEXT_PUBLIC_`; the only public variable is `NEXT_PUBLIC_UMS_ENV_LABEL`. The Supabase anon key is public only once RLS is on (Supabase phase) | Modules that read secrets import `server-only`; CI greps the built `.next/static` for secret name patterns and known prefixes; the sandbox app is a separate PayPal REST app; no live app exists | A |
| 3 Database | Least-privilege app role; buyers see only their own rows; no service role in clients | RLS on PGlite (see above). The control is app-level authorisation in a single data-access module | Ledger append-only (P12); unique keys on capture id, PayPal order id, idempotency key and webhook event id; money as integer minor units with `CHECK (>= 0)`; currency enforced through a `corridors` table (foreign key from orders plus a trigger checking the corridor currency), with US/USD the only enabled corridor in phase 1, so corridors stay configuration; RLS policies written and tested when Supabase arrives (PORT-2) | A, B |
| 4 AuthN and AuthZ | An authorisation check on every route and server action; no cross-buyer reads; operator routes protected; no role escalation path (role is never read from input) | Password hashing: no passwords stored (demo personas behind a scrypt-hashed passcode; Supabase Auth magic link later). MFA for buyers: not offered for the hackathon (residual risk, section 5) | MFA mandatory on operator sign-in and on every team account: GitHub, host, PayPal developer, Anthropic Console, DNS registrar | B, C |
| 5 Public exposure | Inventory of pages, route handlers, server actions, webhooks, operator routes and scheduled jobs, with auth, authz and risk per row | Edge functions: none | The inventory is generated from the Next.js `app/` tree in CI and diffed against the reviewed list; any new route fails the gate until reviewed. The webhook and the return route are public by necessity and are rated high | C |
| 6 AI security | Prompt protection, extraction resistance, injection defence, output validation, tool limits, attack examples with results | Email, SMS, permission and delete tools: the agent has none | The agent has no payment, database-write or network tool (AI-3); prices and payees come from the database, never from model output; approval needs a human click | A, B |
| 7 Input validation | zod `.strict()` on every input; parameterised SQL only; React escaping; CSRF | NoSQL: none. SSTI: no server templates. Command injection: `child_process` is barred by lint | Path traversal: content is looked up by id, never by a path from input; CSRF: SameSite=Lax cookies plus the Next.js server action Origin check (UNVERIFIED that it covers route handlers; add an Origin check there) | A, B |
| 8 DoS | Request and payload limits, timeouts, AI cost abuse | Long password DoS: no passwords | Body limit 64 KB on API routes and the webhook; outbound timeouts: PayPal 10 s, Claude 30 s; edge DDoS from the host's platform (Cloudflare optional, UNVERIFIED per host) | C |
| 9 Rate limiting | Exact limits per endpoint (COST-3) | Registration and password reset: magic link only, so one "sign-in send" limit | Limits never drop a validly signed webhook (PayPal retries): only invalid-signature traffic is limited | C |
| 10 Frontend | No secrets in source or bundles; CSP; secure cookies; storage; clipboard | Clipboard: no use | CSP nonce-based `script-src 'self'` only (no PayPal SDK is loaded; checkout is a redirect); `__Host-` cookies, HttpOnly, Secure, SameSite=Lax; no tokens in `localStorage`; `productionBrowserSourceMaps` stays false | C |
| 11 Production readiness | Debug and dev tools off; no hardcoded credentials; generic errors; secure logging; monitoring; backups; recovery documented | "Test mode disabled" does not fit: this build is sandbox mode by design. Adapted: sandbox on, live impossible (P15), no simulator code in the bundle | Demo personas are PayPal sandbox accounts, not app accounts with default passwords; the operator account is created by a one-time script with MFA | F |
| 12 Supply chain | Vulnerable, abandoned, unused and over-privileged packages | None | AI hallucinated package names (slopsquatting): every new dependency needs a reviewer check of registry age, maintainers and downloads (SUP-4) | A, F |
| 13 Privacy | Inventory, encryption in transit and at rest, retention, deletion, export, no personal data in logs | Signed processor agreements: standard online terms of PayPal, Anthropic and the host only (residual risk). Cookie banner: strictly necessary cookies only, no analytics (UNVERIFIED legal view) | No payer data is sent to Claude; DE and EU sandbox personas mean GDPR-style handling of real team emails and IP addresses (PRIV-1 to PRIV-6) | F |
| 14 Infrastructure | HTTPS on every route; valid certificates; HSTS, X-Frame-Options or `frame-ancestors`, X-Content-Type-Options, Referrer-Policy, Permissions-Policy; least-privilege network; managed secrets; rotation; DNS | CORS: same-origin only, so no CORS headers are sent | Webhook listener on HTTPS 443 (PayPal requirement); egress allow-list in code: `api-m.sandbox.paypal.com` and the allow-listed sandbox webhook cert host, nothing else (the Anthropic API joins only after its approval); CAA record on the domain | C, F |
| 15 Sessions and tokens | Absolute and idle expiry; refresh and revocation; logout; fixation; signing | JWT rules apply only if Supabase Auth is adopted | Approval token: HMAC-signed, single-use, 15 min, bound to the buyer session and the pack hash (M2). PayPal access token cached in memory, never logged, refreshed on expiry or a single 401 | B |
| 16 File upload | Applies only if publishers upload content | MVP-A to MVP-C: no upload endpoint; content is seeded by the operator | MVP-D or MVP-E publisher content: 5 MB cap; text, Markdown or sanitised HTML only; private storage; type sniffed on the server; WordPress pull is an SSRF surface (AI-5, P19) | D, E |
| 17 Logging and IR | Audit trail; alert thresholds; IR plan with named contacts; retention; tamper protection; no secrets or personal data | None | PayPal debug id on every PayPal log line; the audit trail is the append-only ledger plus an append-only `operator_actions` table (OBS, INC) | B, C |
| 18 API object level | BOLA and IDOR; mass assignment; SSRF; webhook signatures | GraphQL, WebSocket, tRPC: none | `paypal-cert-url` host allow-list before any fetch (PayPal's sample code does not check it; P1); the PayPal order id never authorises anything (P6) | B, C, E |
| 19 Extended AI | Least-privilege tools; untrusted output; spend caps | Vector store: none unless embedding search is added; then scope it per catalogue and treat retrieved text as untrusted | Instruction-in-content in article text (AI-1); model cost abuse (AI-4) | B |
| 20 Build and release | SAST, DAST and secret scanning that block merge; full-history scan; real package names; no source maps | Automatic blocking CI: the repo is private and CI is manual-only, so the author pastes the output and the reviewer refuses without it | gitleaks on full history; ESLint security rules as SAST; OWASP ZAP baseline against the hosted sandbox at MVP-C and MVP-F (manual, by Sakthi) | A, C, F |
| 21 Ops hardening | Written threat model; MFA on admin; runtime monitoring; dangling DNS; race tests | None | Capture race test (P4); webhook replay test (P2); threat model in section 3 | C, F |
| 22 Security report | Critical, high, medium and low findings with issue, risk, impact, fix and files | The 0 to 100 score is dropped: false precision. Rule: zero open critical or high findings at a gate | The verdict is renamed to APPROVED FOR SANDBOX DEMO, APPROVED WITH CONDITIONS, or NOT APPROVED | every MVP |
| 23 Document control | Version, preparer, reviewer, approver, dates, revision history | Wet signatures: approval is a merged PR by Sakthi | Re-reviewed at every MVP gate; next review at MVP-C | every MVP |

### 1.2 Added controls the SOP misses

| Id | Control | Test (automated unless stated) |
|---|---|---|
| P1 | Webhook verification over the RAW body before JSON parse. `webhookId` comes from config. `paypal-cert-url` must be https on a PayPal sandbox host from an allow-list, else reject without a fetch. Certificates are cached. A failed check (bad signature, changed byte, wrong webhook id, off-list cert URL) returns 400 and changes no state. An allow-listed cert that cannot be fetched or parsed returns 503, so PayPal retries; it is never recorded as a forgery. A webhook never grants access: it only enqueues a read-back | Forged signature, one changed body byte, wrong webhook id, off-domain cert URL, re-serialised body: all rejected, zero state change |
| P2 | Webhook replay: unique `event_id` and `transmission_id`; a duplicate is acknowledged with 200 and ignored. No tight time window (retries span 3 days); safety rests on dedupe plus an idempotent read-back | Same event 3 times gives 1 read-back enqueue |
| P3 | Idempotency: a `PayPal-Request-Id` on create (`umsC-<order_ref>`), capture (`umsK-<order_ref>`) and refund (`umsR-<refund_request_id>`), where the refs are 128-bit random ids, persisted before the call, reused on every retry. Calls are serialised per order with a row lock, because simultaneous same-key calls may fail. Orders API retention is 6 hours (VERIFIED, OpenAPI header description), so a resend is allowed only within 5 hours of the first send; after that, read-back only. Refund retention: UNVERIFIED | Timeout injected after send, then retry: one PayPal order or capture (fixture replay and one live sandbox run) |
| P4 | Capture race: one capture path. A conditional `UPDATE operations SET state='sent' WHERE id=$1 AND state='prepared' RETURNING id` on the capture operation gates the PayPal call. The return route, sweep and retries all use it | 20 concurrent capture requests give exactly 1 outbound capture |
| P5 | Amount, payee, currency and reference tampering: the order body is built server-side from database prices; the client sends only a pack id and the approval token; the read-back compares each unit to the snapshot; any mismatch freezes the order (M1) | Mutated read-back fixtures (amount +1 cent, other payee, EUR, other `custom_id`): all freeze, no entitlement |
| P6 | Order-id enumeration: internal ids are 128-bit random; every lookup is scoped to the session buyer; the return route ignores any client-supplied PayPal order id and uses the one stored for that approval | Swap order ids across two buyers gives 404; return with a foreign token is rejected |
| P7 | Token handling: client secret only in host settings and Vikram's and Sakthi's `.env.local`; access token in memory; `Authorization` headers redacted by the logger. Access token lifetime: UNVERIFIED, read `expires_in` | Logger test: a seeded token string never appears in output |
| P8 | PCI scope: card entry only inside PayPal-rendered components; no card field in our DOM; script inventory and CSP on the checkout page (SAQ A eligibility criterion) | DOM test: no `input` named like a card field; CSP header present on checkout |
| P9 | Refund and reversal safety: no buyer-facing refund call. An operator refund (MVP-C) needs operator MFA, a reason, and amount <= captured minus refunded, plus a `PayPal-Request-Id` and a read-back after. `REFUNDED` or `REVERSED` from the read-back revokes the entitlement and writes reversal ledger entries. No automatic re-charge (M3) | Double-click refund gives 1 refund; over-refund refused locally; reversal fixture revokes access |
| P10 | Approval replay: the approval token is single-use; the return route is idempotent | Reusing a token gives no new order |
| P11 | Reconciliation integrity: the reconciler compares ledger sums per order with the read-back; a mismatch freezes and alerts; repair is only by a correction entry carrying the operator id, never by UPDATE | Injected ledger drift is detected within one reconciler pass |
| P12 | Ledger append-only: `REVOKE UPDATE, DELETE` from the app role, plus a trigger that raises on UPDATE or DELETE | UPDATE and DELETE attempts raise |
| P13 | Download authorisation: an entitlement row, created only in the unlock transaction after capture and read-back, is checked on every request; revoked means denied | Another buyer's entitlement or link: 404 (no existence oracle). The buyer's own missing, ended or revoked entitlement: 403 with a plain reason |
| P14 | Signed URL leakage: on PGlite, content streams through an authorised route, so no URL exists to leak. With Supabase storage: signed URL expiry <= 60 s, one object, minted after the entitlement check, never logged in full; `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` on article responses | Header test; an expired URL gives 4xx (Supabase phase) |
| P15 | Live mode fail-closed: zod config at boot accepts only `UMS_MODE` `offline` or `sandbox`; there is no `PAYPAL_ENV` and no base URL setting, because the base URL `https://api-m.sandbox.paypal.com` is a code constant; any value naming live or a non-sandbox PayPal host exits non-zero (code 78) before listening; CI fails if a live hostname appears in the tree | Boot with `live`, with an unknown mode, or with a live URL in any value: process exits non-zero |
| P16 | Labels from data: `environment` (`dryrun` or `sandbox`) is stored on every order, receipt and evidence row; the UI label is derived from it | Fixture order with `environment=sandbox` renders "Sandbox"; `dryrun` renders "Dry run" |
| P17 | Windows: a 15-minute approval window; the 24-hour abandonment sweep reads back before any capture and captures only an approved, uncaptured order once | Clock-driven test at 14:59, 15:01, 23:59 h, 24:01 h |
| P18 | Multi-party payees (MVP-D): payee merchant ids only from completed onboarding with `payee_verified_at`. Platform fees and multi-payee orders may need partner permissions: UNVERIFIED for this sandbox app | Order with an unverified payee is refused before the PayPal call |
| P19 | WordPress pull (MVP-E): allow-listed publisher hosts, https only, no redirects to private ranges, 5 s timeout, 2 MB cap; content sanitised and stored as data | SSRF tests: `169.254.169.254`, `localhost`, redirect to `10.0.0.1`: all refused |
| AI-1 | Instruction-in-content: article and publisher text enters the prompt inside delimited, labelled untrusted blocks; the agent cannot set price, payee or approval | Eval set of 30 injected articles: 0 tool-limit breaches, 0 price changes |
| AI-2 | Prompt injection via the reader's brief: same output validation; the system prompt holds no secrets, so extraction has low impact | 20 jailbreak briefs: output always passes the pack schema or is refused |
| AI-3 | Tool permission limits: allow-list `search_catalogue`, `get_article_summary`, `propose_pack`; read-only; no network, no write | Unit test: any other tool name is rejected by the dispatcher |
| AI-4 | Model cost abuse: `max_tokens` 1,024; brief capped at 2,000 characters; per-user and global caps (COST-2) | Cap test: request 21 in an hour gives 429 |
| AI-5 | Untrusted output: the pack proposal is zod-validated, ids are re-resolved in the database, and text is rendered as text, never HTML | XSS payload in model output renders inert |

### 1.3 Per-MVP gate checklist

Each gate produces a report (SOP section 22 format), committed under the sandbox track's docs folder.

- MVP-A walking skeleton: [ ] SOP 1, 2, 3 (constraints), 6 (tool limits), 7, 12, 20 (pipeline) [ ] P3 [ ] P4 [ ] P5 [ ] P12 [ ] P15 [ ] P16 [ ] AI-3 [ ] gitleaks full history clean
- MVP-B single publisher end-to-end: [ ] SOP 3, 4, 6, 7, 15, 17, 18, 19 [ ] P6 [ ] P7 [ ] P10 [ ] P11 [ ] P13 [ ] P14 (route streaming) [ ] P17 [ ] AI-1 [ ] AI-2 [ ] AI-4 [ ] AI-5
- MVP-C hosted with webhooks and refunds: [ ] SOP 4 (operator MFA), 5, 8, 9, 10, 14, 17, 18, 20 (ZAP), 21 [ ] P1 [ ] P2 [ ] P8 [ ] P9 [ ] restore drill [ ] runbook dry run
- MVP-D two publishers: [ ] SOP 16 if uploads exist [ ] P18 [ ] P5 re-run per unit [ ] P11 per publisher
- MVP-E WordPress entry path: [ ] SOP 16, 18 (SSRF) [ ] P19 [ ] AI-1 re-run on WordPress content
- MVP-F hardening and submission: [ ] SOP 1, 11, 12, 13, 14, 20, 21, 22, 23 [ ] secret rotation [ ] ZAP re-run [ ] restore drill [ ] full checklist re-ticked

## 2. Non-functional requirements

Targets apply to the hosted sandbox demo. PayPal sandbox latency is outside our control and has no published SLA (UNVERIFIED). Each target therefore states the server-own time (excluding PayPal and Claude) and the end-to-end time separately.

### 2.1 Performance

| Id | Requirement | Target | Verification |
|---|---|---|---|
| PERF-1 | Ask (brief to proposed pack, includes Claude) | p95 end-to-end <= 8 s; server-own <= 300 ms | Perf script: 50 asks against hosted sandbox; timings from logs |
| PERF-2 | Pack (catalogue match without AI) | p95 <= 300 ms | Perf script, 200 requests |
| PERF-3 | Approve (create PayPal order, return the approve link) | p95 end-to-end <= 2.5 s; server-own <= 200 ms | Perf script, 30 sandbox orders |
| PERF-4 | Capture | p95 end-to-end <= 3 s; server-own <= 200 ms | Logs over the MVP-C soak |
| PERF-5 | Read-back | p95 end-to-end <= 1.5 s | Logs |
| PERF-6 | Return to content visible (capture, read-back, unlock) | p95 <= 6 s; spinner with live status text after 1 s | Manual timed run x10 plus logs |
| PERF-7 | Page loads, buyer flow | LCP p75 <= 2.5 s, INP <= 200 ms, CLS <= 0.1 (Core Web Vitals "good") | Lighthouse on 4 pages, mobile profile |
| PERF-8 | Webhook acknowledgement (verify plus enqueue only) | p95 <= 500 ms | Logs |
| PERF-9 | Reconciler budget | A pass over <= 500 open operations finishes in <= 60 s; <= 2 PayPal requests per second overall; <= 1 read per operation per schedule step; CPU <= 20 percent of one core averaged over a pass | Load test with fixture provider; rate counter in logs |

PERF-9 notes (BU-5, `packages/jobs`, `domain/payments/src/due.ts`):

- The polling allowance is counted in calls, the unit the outbound gate counts. Before each pass the job loop sets a quota on the provider port it hands to payments; the port answers `blocked` (by `budget`) once the pass has used it, and payments pauses and retries on a later pass. One item costs 1 to 4 calls (a re-read 2; an abandoned-but-approved order 4: get, get, capture, get; an unknown capture with the P3 retry 3), so a quota in items would overdraw the budget.
- Known limit (ASM-BU5-5): two loops that share one `callBudget` are not capped together; each reads the same remaining count. The design is one loop per approval and composition starts one. The claim on a paid re-read only stops the same order being read twice by passes at once.
- Known limit: a process that dies between claiming a paid re-read and reading the order postpones that re-read by one cadence (6 h in sandbox mode); the next unknown-operation sweep does not repair it.
- The call gap (`min_call_gap_ms`, default 500) spaces port methods, not HTTP requests: a retry inside one transport call is not spaced. Startup recovery that composition runs itself and the return route's own capture go through neither the gap nor the quota; the gate alone decides them. Recovery run by the loop (`recover_on_start`) is gap-limited but not quota-limited.
- Sandbox mode fails closed: a loop without a `callBudget` runs money passes only (`jobs.loop.no_call_budget`); a `reread_paid_every_ms` outside 1 ms to 24 h refuses to start (`jobs.loop.bad_config`); under 6 h it warns (`jobs.loop.reread_too_frequent`).

### 2.2 Reliability and availability

| Id | Requirement | Target | Verification |
|---|---|---|---|
| REL-1 | Availability, first hosted deploy to 15 Dec | 99.5 percent monthly (about 3.6 h downtime per month), measured by an external check every 5 min on `/healthz` and one buyer page | Uptime monitor report |
| REL-2 | Restart safety | All money state is in the database; boot runs the config check (P15), migration check and reconciler resume; nothing money-related lives only in memory | Kill -9 during capture in a test; after restart the order reaches a terminal or frozen state within 2 reconciler passes |
| REL-3 | Crash recovery of in-flight calls | An unknown-outcome capture is resolved by read-back, never by re-capture without the same request id (M3) | Fault-injection test |
| REL-4 | Idempotent jobs | Every job is keyed by operation id; running a job twice changes nothing the second time | Unit test per job |
| REL-5 | Backups, PGlite | `dumpDataDir` every 15 min and before each deploy, copied off the host, 7 days retained; plus a nightly logical SQL export (the tarball is PGlite-only) | Restore drill at MVP-C and MVP-F |
| REL-6 | Backups, Supabase | Provider daily backups plus the nightly logical export; point-in-time recovery depends on plan (UNVERIFIED) | Restore drill on adoption |
| REL-7 | RPO and RTO | RPO <= 15 min for app data. Money truth is recoverable from PayPal read-backs for every order id we hold. RTO <= 30 min | Timed drill |
| REL-8 | Hosting fit | PGlite on disk needs one long-running Node process with a persistent volume; serverless functions are excluded until Supabase | Architecture review |

### 2.3 Scalability

Baseline (demo): 5 concurrent buyers, 50 orders per day, 2 publishers.

| Id | Load | What holds, what breaks | Action |
|---|---|---|---|
| SCAL-1 | 10x: 50 concurrent, 500 orders per day | Single instance holds. Claude cost is the first limit (COST-2) | None beyond caps |
| SCAL-2 | 100x: 500 concurrent, 5,000 orders per day | PGlite single-writer and single-connection limits (single connection: UNVERIFIED in current docs); in-memory rate limiter and token cache do not survive multiple instances; reconciler polling approaches PayPal throttling | Move to Supabase Postgres with pooler; stateless instances; limiter state in Postgres; reconciler leader via advisory lock; webhook-first, poll second |
| SCAL-3 | Migration path | Same SQL migrations run on PGlite and Postgres in CI (PORT-1); data moved by logical export; cut-over in a 30 min freeze with checkout off (RLR-3) | Rehearsal on a copy |
| SCAL-4 | Breakpoint watch | Alert at p95 DB query > 50 ms or event-loop lag > 100 ms | Metrics |

### 2.4 Observability

| Id | Requirement | Target | Verification |
|---|---|---|---|
| OBS-1 | Structured JSON logs | Fields: time, level, `request_id`, `operation_id`, `order_ref`, PayPal order id, capture id, `paypal_debug_id`, route, latency, outcome | Log schema test |
| OBS-2 | Redaction by allow-list | Only listed fields are emitted; emails hashed; `Authorization`, cookies, tokens, raw webhook bodies and briefs never logged | Seeded-secret test (P7) |
| OBS-3 | Correlation | One `request_id` from browser action to PayPal call; the PayPal debug id is stored with each PayPal call record | Trace one order end to end in the review |
| OBS-4 | Metrics | Counters: orders by state, captures, read-back mismatches, frozen orders, webhook valid and invalid, 429s, Claude tokens and dollars; latency histograms for PERF ids | Operator view shows them |
| OBS-5 | Alerts to Vikram and Sakthi | Any frozen order: immediate. Operation open > 30 min: warn. Unknown at 24 h: page. Invalid signatures > 5 in 10 min. 5xx > 2 percent over 5 min. Two failed uptime checks. Claude spend > 80 percent of daily cap | Fire each alert once in a drill |
| OBS-6 | Operator view | Read-only, operator MFA: open and frozen operations, last read-back diff, debug ids, kill switch states, reconciler lag | Manual check |

### 2.5 Data privacy and retention

| Id | Requirement | Target | Verification |
|---|---|---|---|
| PRIV-1 | Inventory | Held: buyer email and display name; PayPal payer id; publisher payee merchant id; orders, ledger, entitlements; IP in access logs; reader briefs. Not held: card data, addresses (digital goods, request no shipping) | Data map in docs, reviewed |
| PRIV-2 | Minimisation to AI | Briefs go to Claude without email, name or payer id | Unit test on prompt builder |
| PRIV-3 | Retention | Logs 30 days; briefs 30 days; orders and ledger to 15 Jan 2027, then deleted with the sandbox data | Deletion script run and checked |
| PRIV-4 | Rights | Export and deletion by operator script within 30 days of request; ledger rows pseudonymised, not deleted | Script test |
| PRIV-5 | Encryption | TLS 1.2+ in transit; host disk encryption at rest (UNVERIFIED per host); backups encrypted before off-host copy | Review |
| PRIV-6 | GDPR awareness | DE and EU sandbox personas are fictitious, but team emails and IPs are real personal data: lawful basis and notice on the sign-in page | Review |

### 2.6 Compliance gates

PCI scope statement: UnitMarket never receives, stores, processes or transmits card numbers. Card and wallet entry happens only inside PayPal-rendered components. In sandbox no real cardholder data exists. A production version would target SAQ A, including the new eligibility criterion that the site is not susceptible to script attacks, met by CSP and a script inventory on the checkout page (P8). Out of scope: Payouts and money transmission; KYC (PayPal onboarding); card vaulting; sales tax on digital goods (UNVERIFIED obligations, not in sandbox); UK and India rules until those phases.

| Id | Gate | Verification |
|---|---|---|
| COMP-1 | PCI scope statement unchanged, or re-reviewed on any checkout change | Review |
| COMP-2 | No card field in our DOM (P8) | Automated |
| COMP-3 | No live credential exists anywhere (P15) | Automated plus review |
| COMP-4 | Sandbox label on every money screen and receipt (P16) | Automated |

### 2.7 Accessibility, buyer flow, WCAG 2.2 AA essentials

| Id | Requirement | Verification |
|---|---|---|
| A11Y-1 | Full flow by keyboard: ask, pack, approve, return, read; visible focus not obscured (2.4.7, 2.4.11) | Manual keyboard run |
| A11Y-2 | Contrast 4.5:1 text, 3:1 UI (1.4.3, 1.4.11) | axe scan |
| A11Y-3 | Target size >= 24 by 24 CSS px (2.5.8) | axe scan plus review |
| A11Y-4 | Payment status changes announced via `aria-live` (4.1.3) | Screen reader check, VoiceOver |
| A11Y-5 | 15-minute approval window warned at 2 min left with a one-step renewal (2.2.1) | Manual |
| A11Y-6 | Sign-in without a cognitive test, magic link allowed (3.3.8); no redundant entry (3.3.7) | Review |
| A11Y-7 | Errors identified in text with a suggestion (3.3.1, 3.3.3) | Manual |

The axe scanner is a new dependency; it needs approval in the spec.

### 2.8 Maintainability and testability

| Id | Requirement | Target | Verification |
|---|---|---|---|
| MAINT-1 | Track isolation | Sandbox track in its own repository (D-1, local at `/home/user/unitmarket-sandbox`) with its own package.json, lockfile, CI workflow and docs; lint and an import-resolver check bar any import of simulation code | Lint rule plus CI grep |
| MAINT-2 | Module boundaries | `paypal-adapter` (only module that calls PayPal), `payments` (state machine), `ledger`, `entitlements`, `agent` (no import of payments or adapter), `web` (ports only) | Lint `no-restricted-imports` |
| MAINT-3 | Contract tests | Adapter tested against sanitised recorded sandbox fixtures offline; live sandbox suite only behind `UMS_SANDBOX_TESTS=1` plus an active outbound approval, run manually by Vikram or Sakthi | CI offline run plus pasted live output |
| MAINT-4 | Mutation checks on money paths | Mutation score >= 80 percent on payments, read-back comparison, entitlements, access clock, ledger, with a dependency-free mutation script adapted from the simulation's `scripts/mutation-checks.mjs` (Stryker would need a new approval) | Report at MVP-B and MVP-F |
| MAINT-5 | Fixtures | Every fixture sanitised (no emails, no real ids), hashed and listed | Fixture lint |
| MAINT-6 | Coverage | Branch coverage >= 90 percent on money modules | vitest coverage |

### 2.9 Portability (Supabase provisions)

| Id | Requirement | Verification |
|---|---|---|
| PORT-1 | Plain forward-only numbered SQL migrations; no PGlite-only or Supabase-only features without a guard; CI runs them on PGlite and on a stock Postgres of the version Supabase offers (version UNVERIFIED) | CI job |
| PORT-2 | RLS policies written per table (buyer owns orders, entitlements, receipts; ledger read-only to operator) and tested with two JWT roles on Supabase | Policy tests on adoption |
| PORT-3 | App connects as a non-owner role without BYPASSRLS; the service role key is server-only | Review |
| PORT-4 | Storage: private bucket, signed URLs per P14 | Test on adoption |
| PORT-5 | Auth: Supabase Auth with MFA for operator; user id mapping kept stable | Review |

### 2.10 Cost and quota

| Id | Requirement | Target | Verification |
|---|---|---|---|
| COST-1 | PayPal quota | Token cached; webhooks first, polling per reconciler schedule; 429 or 5xx retried with exponential backoff (1, 2, 4, 8 s, max 4 tries) and the same request id | Fault-injection test |
| COST-2 | Claude caps | App-level daily cap (default USD 10, set by Vikram) that disables ask when reached; Console workspace spend limit set (UNVERIFIED feature name); spend logged to `docs/spend-log.md` weekly | Cap test plus Console screenshot |
| COST-3 | Rate limits | Sign-in send 5 per hour per email, 20 per hour per IP; ask 20 per hour per user, 200 per day global; approve 10 per hour per user; download 60 per hour per user; invalid webhook 60 per min per IP | Automated limiter tests |
| COST-4 | Hosting | Budget cap set by Vikram (suggest <= USD 25 per month, UNVERIFIED prices); billing alert at 80 percent | Host billing alert screenshot |

### 2.11 Supply chain

| Id | Requirement | Verification |
|---|---|---|
| SUP-1 | `pnpm install --frozen-lockfile` in CI; exact versions; lockfile reviewed in every PR | CI |
| SUP-2 | `pnpm audit --prod`: zero high or critical at each gate, or a dated waiver | Gate report |
| SUP-3 | New releases quarantined 7 days (pnpm `minimumReleaseAge`, UNVERIFIED for 10.34.7) | Config review |
| SUP-4 | New dependency check: registry age > 90 days, a known maintainer, no install scripts unless approved | Reviewer checklist |
| SUP-5 | SBOM (CycloneDX) generated at MVP-F and attached to the submission (tool choice UNVERIFIED) | Artifact |
| SUP-6 | gitleaks on staged files and full history | CI output |

### 2.12 Release and rollback

| Id | Requirement | Verification |
|---|---|---|
| RLR-1 | Promotion: offline (fixtures, no network) to local sandbox (Vikram or Sakthi only) to hosted sandbox demo; deploy only from a reviewed tag on main | Release notes |
| RLR-2 | Rollback: redeploy the previous image within 10 min; migrations expand-then-contract so the previous image runs on the new schema | Rollback drill at MVP-C |
| RLR-3 | Kill switches read per request from the database: `paypal_outbound` (emergency stop: every PayPal call, reads included, is blocked and the reconciler pauses), plus `checkout_enabled`, `ai_enabled`, `refunds_enabled`, `unlock_enabled`, `webhook_enabled`. These five mean a clear message and no new money movement; the reconciler keeps running | Toggle test |
| RLR-4 | Fail-closed config: zod schema at boot; missing or unknown value exits; live mode impossible (P15) | Boot tests |
| RLR-5 | Webhook endpoint off returns 503; PayPal retries for 3 days, so nothing is lost if the switch is back within that time | Manual drill |

### 2.13 Incident response

Contacts: Vikram (owner, decides), Sakthi (on-call reviewer, executes). Severity 1: possible wrong money or wrong access. Severity 2: checkout down. Severity 3: degraded. Acknowledge within 15 min for Sev 1 in waking hours (UNVERIFIED staffing overnight; see section 5).

Runbook INC-1, mismatched payment (read-back differs from snapshot):

1. Confirm the order is frozen and has no entitlement (automatic under M1).
2. Turn `checkout_enabled` off if more than one order is affected.
3. Open the operator view; record the PayPal order id, capture ids and debug ids.
4. Compare the snapshot with a fresh read-back. Classify: our mapping bug, PayPal state change, or tampering.
5. If money was captured and access is not due, refund via the operator path (P9). Never "fix" by editing ledger rows; add a correction entry.
6. Record the incident in `docs/decision-log.md` within 24 h.

Runbook INC-2, stuck payment (capture outcome unknown, or pending past 30 min):

1. Do not capture again.
2. Run a manual read-back with the stored request id.
3. If `COMPLETED` and matching, let the unlock proceed. If `PENDING`, keep polling on schedule. If unknown at 24 h, mark it `unresolved`, tell the buyer that access is not granted and no further charge will be made, and escalate to Vikram.

Runbook INC-3, leaked secret: rotate within 1 hour (existing rule), redeploy, scan the logs, and record it.

Runbook INC-4, suspected double capture: freeze both orders, read back both, refund the duplicate, and add a regression test before checkout is turned back on.

## 3. Threat model for the two PayPal hazards

H1 is false confirmation: access granted without matching money. H2 is wrong money movement: double, wrong amount, wrong payee or unsafe refund.

| # | STRIDE | Attacker and target | Impact | Control | Test |
|---|---|---|---|---|---|
| 1 | Spoofing (H1) | Outsider posts a forged `PAYMENT.CAPTURE.COMPLETED` to the webhook | Free content | P1 signature over raw body; webhook only enqueues a read-back | Forged and altered-body tests |
| 2 | Spoofing (H1) | Attacker sets `paypal-cert-url` to their own certificate | Forgery accepted; SSRF | Cert host allow-list before fetch | Off-domain URL rejected, no outbound call |
| 3 | Repudiation and replay (H1) | Old genuine webhook replayed | Re-unlock after a refund | P2 dedupe; read-back decides state | Replay after a refund fixture leaves access revoked |
| 4 | Tampering (H2) | Buyer edits the price or payee in the request | Underpayment or diverted funds | P5 server-built order, snapshot match | Mutated fixture freezes |
| 5 | Tampering (H1) | Buyer returns with another approved order id (cheaper pack) | Expensive access for a cheap payment | P6 stored order id per approval; reference and amount match | Swapped-id return rejected |
| 6 | Information disclosure (H1) | Buyer enumerates order or download ids | Others' receipts or content | 128-bit ids; session scoping; P13 | Cross-buyer 404 and 403 |
| 7 | Denial of service (H2) | Retry storm or double click on capture | Double charge, or 429 lockout | P3 request id; P4 conditional transition; COST-1 backoff | 20 concurrent captures give 1 call |
| 8 | Elevation of privilege (H2) | Stolen operator session issues refunds | Money loss | MFA, idle 30 min, `refunds_enabled`, refund <= remaining | Over-refund refused; no MFA gives 403 |
| 9 | Tampering (H1) | Prompt-injected article tells the agent to add free items or change price | Unpaid access or a mispriced pack | AI-1, AI-3, AI-5; prices from the database | Injection eval: 0 breaches |
| 10 | Information disclosure (H2) | Client secret or access token reaches logs or bundle | Account abuse on the sandbox app | M4, P7, bundle grep, gitleaks | Seeded-secret tests |
| 11 | Spoofing (H2) | Config drift points to live PayPal | Real money moves | P15 fail-closed, egress allow-list | Boot with live exits 1 |

## 4. Requirement to MVP and verification map

Key: Auto = automated test, Rev = review, Man = manual check. "Holds from" means the requirement must pass at that gate and at every later gate.

| Requirement | Holds from | Verification |
|---|---|---|
| P3, P4, P5, P12, P15, P16, AI-3 | MVP-A | Auto |
| SOP 1, 2, 12, SUP-1, SUP-4, SUP-6 | MVP-A | Auto plus Rev |
| MAINT-1, MAINT-2, MAINT-5, PORT-1, RLR-4 | MVP-A | Auto |
| REL-2, REL-3, REL-4 | MVP-A | Auto |
| P6, P7, P10, P11, P13, P14, P17 | MVP-B | Auto |
| AI-1, AI-2, AI-4, AI-5, PRIV-2 | MVP-B | Auto (evals) |
| PERF-2, PERF-3, PERF-5 | MVP-B | Auto (perf script) |
| OBS-1, OBS-2, OBS-3 | MVP-B | Auto plus Rev |
| MAINT-3, MAINT-4, MAINT-6 | MVP-B | Auto |
| COMP-2, COMP-3, COMP-4 | MVP-B | Auto |
| COST-2 | MVP-B | Auto plus Man (Console) |
| P1, P2, P8, P9 | MVP-C | Auto |
| SOP 4 (operator MFA), 5, 8, 9, 10, 14, 20 (ZAP), 21 | MVP-C | Auto plus Man |
| PERF-1, PERF-4, PERF-6, PERF-7, PERF-8, PERF-9 | MVP-C | Auto plus Man |
| REL-1, REL-5, REL-7, REL-8 | MVP-C | Man (drill, monitor) plus Rev |
| OBS-4, OBS-5, OBS-6 | MVP-C | Man (alert drill) |
| COST-1, COST-3, COST-4 | MVP-C | Auto plus Man |
| RLR-1, RLR-2, RLR-3, RLR-5 | MVP-C | Man (drill) plus Auto (RLR-3) |
| INC-1, INC-2, INC-3, INC-4 | MVP-C | Man (dry run) |
| A11Y-1 to A11Y-7 | MVP-C | Auto (axe) plus Man |
| COMP-1 | MVP-C | Rev |
| SCAL-1, SCAL-4 | MVP-C | Auto (metrics) |
| P18, SOP 16 (if uploads) | MVP-D | Auto |
| P19, AI-1 re-run | MVP-E | Auto |
| SUP-2, SUP-3, SUP-5 | MVP-F | Auto plus Rev |
| PRIV-1, PRIV-3, PRIV-4, PRIV-5, PRIV-6 | MVP-F | Rev plus Man (deletion script) |
| SOP 11, 13, 22, 23; secret rotation | MVP-F | Rev plus Man |
| SCAL-2, SCAL-3, REL-6, PORT-2 to PORT-5 | Supabase adoption (after MVP-F unless pulled forward) | Auto plus Rev |

## 5. What we deliberately do not do, and the residual risk

1. No MFA for buyers. Risk: account takeover exposes purchase history and content; no money moves without PayPal approval.
2. No RLS on PGlite. Risk: one missed app-level check exposes rows; mitigated by a single data-access module and cross-buyer tests.
3. No automatic blocking CI while the repo is private. Risk: a skipped check merges; mitigated by pasted output and the reviewer refusing without it.
4. No 24x7 human on-call. Risk: a night-time Sev 1 waits hours; mitigated by fail-closed freezes, so the failure mode is "no access", not "wrong money".
5. No signed DPAs, no legal review of privacy notices. Risk: notice gaps; acceptable for fictitious sandbox data and the team's own personal data.
6. No WAF or bot management beyond the host default. Risk: abuse of ask or sign-in; mitigated by rate limits and AI caps.
7. No dispute and chargeback handling beyond revoke-on-reversal. Risk: unmodelled dispute states; sandbox only.
8. No multi-instance or high-availability deployment before Supabase. Risk: a host outage means downtime within the 99.5 percent budget; RPO 15 min.
9. No penetration test by a third party; ZAP baseline and the internal review only. Risk: logic flaws found late.
10. No UK, India, tax or Payouts logic. Risk: design assumptions (USD-only, single currency checks) need rework later.

Simulation proves modelled cases only, not PayPal compatibility.
