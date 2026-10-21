# UnitMarket Sandbox track (SBX): MVP plan

Status: **BASELINE v1.0**, 21 Oct 2026. Owner decisions D-1 to D-9 and open items O-1 to O-3 are recorded at the top of `architecture.md`; in short: separate repository at `/home/user/unitmarket-sandbox`, clock starts at verified payment plus verified deliverability, D2 is the default composite route, dependency list approved, accounts deferred (MVP-A uses fixtures only), hosting researched separately, no PayPal connection without the owner's explicit approval. Construction specs for MVP-A are in `lanes/`.

Companion to `architecture.md` (design) and `nfr.md` (controls P1 to P19, AI-1 to AI-5, NFR ids, per-gate SOP checklist). Every gate below cites those ids; a gate passes only with zero open critical or high findings (nfr.md SOP 22).

Roles: design Opus 5.5; construction Sonnet 5.5 medium, one lane per spec and branch; verification Opus 5.5 medium, independent, reviewing against the requirement, not the code. Every money lane (marked $) gets an Opus diff review and mutation checks. Only Vikram and Sakthi run anything that touches PayPal. Sakthi reviews and merges (SBX keeps the spec protocol of the simulation `CLAUDE.md`, copied into the SBX `CLAUDE.md`).

Calendar (owner may move): MVP-A Thu 22 to Mon 26 Oct (offline). Mon 26 Oct: owner decisions (PayPal sandbox go, host, repo option, dependency list). Spike Tue 27 Oct. MVP-B Tue 27 to Fri 30 Oct. MVP-C Fri 30 Oct to Tue 3 Nov. Money-path dependency freeze Mon 2 Nov (nfr.md SOP 1). MVP-D Mon 2 to Thu 5 Nov. MVP-E Wed 4 to Fri 6 Nov (first to cut). MVP-F Thu 5 to Sun 8 Nov. Submit Mon 9 Nov; deadline Thu 12 Nov.

## MVP-A: walking skeleton, offline

**Goal.** The whole single-publisher journey (publisher offer to approval to order to capture to read-back to access to receipt) runs end to end with the dry-run transport and no network. Every safety structure exists before any PayPal call is possible.

**Modules.** `contracts`, `config`, `runtime`, `safety`, `transport` (dry-run and egress guard; sandbox HTTPS client compiled but unreachable without gates), `paypal` (mapping, error map, OAuth cache logic), `db` (PGlite driver, common migrations, RLS spike), `obs`, `security`, `catalogue`, `offer-entry`, `approval`, `payments`, `entitlements`, `access-clock`, `delivery`, `ledger`, `receipts`, `recovery` (system-opened cases), `jobs` (in-process loop), `testkit`, `apps/web` (design system, offer page, approval, return, library, receipt, ops overview), `tools/checks`.

**Design slices.** Architecture 2.2, 2.3, 3 (steps 1 to 15), 4.1 to 4.5, 5, 6, 7, 8 (PGlite), 9.1 (no webhook), 9.2 to 9.9, 9.12.

**User-visible result.** On localhost, a buyer opens a sample publisher's article offer, sees an all-in price and two access options, approves, is "redirected" to a dry-run approval page clearly labelled "Dry run: no PayPal", returns, and sees the item in the library only after the read-back step, with a five-day window and a receipt. The ops page shows orders, operations, the kill switch and the approval gate state.

**Acceptance tests** (expected results from the adopted requirements):

| Name | Expected result |
|---|---|
| A-01 `boot_refuses_live` | Any PayPal-related config value containing `live` or `production`, an unknown `UMS_MODE`, or any non-sandbox PayPal hostname in any value: process exits non-zero before listening; no transport object is built (P15, RLR-4) |
| A-02 `offline_opens_no_socket` | Full test run in offline mode with `net.connect`, `tls.connect` and global `fetch` spied: zero calls outside the dry-run transport |
| A-03 `gates_block_outbound` | Sandbox transport with no approval row, an expired row, a scope that does not cover the call, an amount above `max_amount_cents`, or `paypal_outbound` tripped: `blocked` with the right reason; no request leaves |
| A-04 `egress_guard` | Wrong host, http scheme, port 8443, redirect, path not on the list (for example a payouts path), order id not matching `^[A-Z0-9]{1,36}$`: refused |
| A-05 `offer_quote_within_ceiling` | Authorised offer, price below the buyer's ceiling: scoped quote valid 15 min. Ceiling below price: `no_match above_ceiling` and no other offer is proposed (no automatic substitution) |
| A-06 `no_universal_floor` | A publisher price of 0.40 USD is quoted as 0.40 USD (no 1 USD floor) |
| A-07 `renegotiation_permissioned` | Offer without renegotiation: a lower proposal is `no_match`. Offer with floor 2.00: proposal 2.50 accepted at 2.50; 1.90 is `below_publisher_floor` |
| A-08 `snapshot_frozen` | Snapshot holds offer id and version, terms version, payee, amount, currency, rights, access policy and version, reader id, rule version. Publisher changes the price after approval: the order uses the frozen price. Tampered token 403; after 15 min 410; reuse 409 (P10) |
| A-09 `mixed_currency_rejected` | A selection with USD and GBP items is refused before approval with `mixed_currency` |
| A-10 `order_before_charge` | Order, expected transaction, unit, pending entitlement and `prepared` operation exist when the transport spy sees the create call |
| A-11 `claim_never_unlocks` | Capture fixture 201 COMPLETED, read-back fixture `unavailable`: item locked, library shows "Confirming payment" |
| A-12 `readback_match_unlocks_and_starts_clock` | Matching read-back: item available; window `started_at` equals the verified-and-ready moment; `ends_at` exactly 5 days later |
| A-13 `mismatch_freezes` | Read-back with amount +1 cent, other payee, EUR, or other `custom_id`: order frozen, item locked, alert and recovery case created, no ledger sale (P5) |
| A-14 `lost_response_one_capture` | Capture times out after send; read-back COMPLETED: one capture recorded, at most one retry with the same key and only within 5 h, item unlocked once (P3, REL-3) |
| A-15 `concurrent_capture_one_call` | 20 concurrent return requests for one order: exactly one outbound capture (P4) |
| A-16 `pending_never_unlocks` | Read-back PENDING with reason `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`: locked; buyer sees "Payment pending at PayPal" |
| A-17 `readiness_before_charge` | Content hash differs from the snapshot: no capture call; order `failed`, buyer told "not charged" |
| A-18 `lost_time_restored_free` | Delivery fails on day 1 for 6 h, then succeeds: `ends_at` moves 6 h later; the new link creates no order and no ledger entry |
| A-19 `history_stays` | After `ends_at`: keep item shows "Retrieval closed, your copy is yours"; online item shows "Reading ended"; both still listed with receipts |
| A-20 `buyer_isolation` | Buyer B requests buyer A's order, entitlement, link, receipt or case by id: 404; data-access module refuses without an actor (P6, P13) |
| A-21 `ledger_append_only` | UPDATE or DELETE on ledger, receipts, approvals, access events, audit log raises (P12) |
| A-22 `labels_from_data` | Every money screen and receipt shows the label derived from the stored `environment` (`Dry run` or `Sandbox`) (P16, COMP-4) |
| A-23 `fixtures_map` | Every fixture under `fixtures/paypal/**` parses and maps through the adapter; every fixture carries a source label (MAINT-5) |
| A-24 `conformance_dryrun` | Adapted C1 to C15 pass against the dry-run transport |
| A-25 `no_secret_in_bundle` | Build with a canary secret: canary absent from `.next/static` and client chunks; no `NEXT_PUBLIC_` secret name |
| A-26 `no_live_host_in_tree` | CI grep for live hostnames: none |
| A-27 `isolation_from_simulation` | Import resolver check: no specifier resolves outside the SBX root; no `@unitmarket/*` or `@unitmarket-sim/*` (MAINT-1) |

**Gates.** nfr.md MVP-A list: SOP 1, 2, 3, 6, 7, 12, 20; P3, P4, P5, P12, P15, P16, AI-3; MAINT-1, MAINT-2, MAINT-5, PORT-1, RLR-4, REL-2 to REL-4; gitleaks full history clean.

**Real versus fixture.** All fixture. Fixtures: `docs-example` (OpenAPI `x-samples`) and `synthetic` (from simulation scenarios S1 to S6 and the RB-13 list). No sandbox recording exists yet; the README says so.

**Dependencies and approvals.** Decided: separate repository at `/home/user/unitmarket-sandbox` (D-1) and the dependency list (D-4). No PayPal approval needed; no account is used.

**Lanes** (about 21 lane-days; 7 parallel workers gives about 4 calendar days):

| Lane | Content | Days | Verify |
|---|---|---|---|
| A-L1 repo | Scaffold, lint rules S1 to S7, CI script, provenance check, `CLAUDE.md` | 0.5 | Opus |
| A-L2 contracts | Copy-adapt schemas; new window, evidence, quote, fit, corridor | 1 | Opus |
| A-L3 config, safety, transport $ | Boot refusal, gates, egress guard, dry-run | 1.5 | Opus |
| A-L4 paypal mapping $ | Money conversion, create, order, capture, error map, OAuth cache | 2 | Opus |
| A-L5 db $ | PGlite driver, common migrations, RLS spike, export-sql skeleton | 1.5 | Opus |
| A-L6 approval $ | Copy-adapt canonical, token, snapshot | 1 | Opus |
| A-L7 payments place and capture $ | P1 to P5 equivalents, readiness check | 1.5 | Opus |
| A-L8 payments reconcile and jobs $ | match, reconcile, due, startup recovery | 1.5 | Opus |
| A-L9 entitlements and clock $ | Table, windows, credits, sweeper | 1.5 | Opus |
| A-L10 delivery, ledger, receipts $ | Content route, evidence, ledger, receipts | 1.5 | Opus |
| A-L11 offer entry and catalogue | startFromOffer, seed of 2 publishers, 8 articles (team-written) | 1 | gates |
| A-L12 recovery | System cases | 1 | gates |
| A-L13 security | withRoute, sessions, CSRF, headers, rate limits | 1.5 | Opus |
| A-L14 web | Design system, buyer and ops screens | 2.5 | gates plus screenshot review |
| A-L15 testkit | Conformance port, HTTP-level fake PayPal | 1 | Opus |

**Stop conditions.** Any test shows an item available without a verified capture; any socket opened in offline mode; boot accepts a live value; RLS spike inconclusive is not a stop (falls back to app-level control, nfr.md section 5 item 2).

## MVP-B: single publisher end to end on the PayPal sandbox, polling only

**Goal.** The MVP-A journey runs against the real sandbox, in the currency chosen by the spike (US/USD by direction), with polling reconciliation and no webhooks. The agent-led path and the visual match dashboard join, offline-safe.

**Modules.** `transport` sandbox client enabled, `paypal` OAuth live path, `testkit` sandbox conformance subject (gated `UMS_SANDBOX_TESTS=1`), fixture recorder, `discovery`, `fit`, `model` (scripted), `apps/web` discover and match screens, perf script.

**Slices.** Architecture 3 (all steps except 17), 9.10, 9.11, section 12 phase 1.

**User-visible result.** On Vikram's or Sakthi's laptop (PGlite on disk), a buyer approves at the real PayPal sandbox page, returns, and gets access only after read-back; the receipt shows a sanitised capture id that matches the sandbox dashboard. The `/discover` page shows fit cards with no fabricated scores.

**Acceptance tests:**

| Name | Expected result |
|---|---|
| B-01 `sandbox_happy_path` | One real order: create, approve, capture, read-back match, access; capture id visible in the sandbox dashboard; evidence in the PR with sanitised ids and debug ids |
| B-02 `create_replay_same_key` | Second create with the same `PayPal-Request-Id`: same order id (C2) |
| B-03 `capture_replay_same_key` | Second capture with the same key: same capture id, 200, one capture (C6) |
| B-04 `capture_before_approval` | 422 `ORDER_NOT_APPROVED` mapped; no state change; buyer sent back to approve (C9 adapted) |
| B-05 `cancel_then_abandon` | Buyer cancels at PayPal: order `awaiting_buyer`; after the abandonment window (shortened only in a labelled test profile): `abandoned`, nothing charged (P17) |
| B-06 `kill_switch_mid_flow` | Switch tripped between approval and capture: call blocked, "Payments paused"; after reset the order completes with one capture |
| B-07 `client_timeout_reconciles` | Client timeout forced on capture: reconciler read-back resolves; one capture in the dashboard (REL-3) |
| B-08 `call_budget` | `provider_calls` for one happy order: at most 6 PayPal calls (token, create, pre-capture GET, capture, post-capture GET, capture GET) |
| B-09 `logs_clean` | Seeded token and email strings absent from every log line and every `provider_calls` row; debug ids present (P7, OBS-1 to OBS-3) |
| B-10 `fit_cards_honest` | Every displayed level has a basis and evidence; missing data renders "not assessed"; same brief twice gives the same cards; no percentages |
| B-11 `both_paths_same_approval` | Offer path and discovery path reach the same approval screen and snapshot shape (PAY-10) |
| B-12 `injection_set` | Injected listings and briefs: zero price or payee changes, zero tool-limit breaches, output rendered as text (AI-1, AI-2, AI-5) |
| B-13 `fixtures_promoted` | Redacted recordings from B-01 to B-07 committed as `sandbox-recording`; A-23 still passes; recordings contain no email, name, token or payer id |

**Gates.** nfr.md MVP-B list: SOP 3, 4, 6, 7, 15, 17, 18, 19; P6, P7, P10, P11, P13, P14 (route streaming), P17; AI-1, AI-2, AI-4 (inert without an API key, cap code still tested), AI-5; PERF-2, PERF-3, PERF-5; MAINT-3, MAINT-4, MAINT-6; COMP-2 to COMP-4; threat model draft.

**Real versus fixture.** Real sandbox: B-01 to B-08, B-13, run by the owner. Fixture: B-09 to B-12 in CI.

**Dependencies and approvals.** Owner's phase go for sandbox calls recorded in the decision log; an `outbound_approvals` row with scope `mvp_b_polling` (suggest max 20 USD per order, 300 calls per day, valid 7 days); spike done and currency chosen; the owner's account choice (O-1).

**Lanes** (about 7.5 lane-days, 2 calendar days with 4 workers, plus owner sessions):

| Lane | Days | Verify |
|---|---|---|
| B-L1 sandbox transport and OAuth $ | 1 | Opus |
| B-L2 sandbox conformance subject, manual approve hook (wait for the owner's browser approval) | 1 | Opus |
| B-L3 recorder and redaction $ | 0.5 | Opus |
| B-L4 discovery, fit, scripted model, match screens | 2 | Opus (fit honesty) |
| B-L5 jobs hardening, hourly paid-order re-read | 1 | Opus |
| B-L6 owner session runbook and evidence template | 0.5 | Sakthi |
| B-L7 perf and log-scan scripts | 0.5 | gates |
| Owner sessions (Vikram or Sakthi) | 2 x 2 h | |

**Stop conditions.** Read-back fields differ from the mapping in a way that would unlock wrongly: stop, record, fix mapping offline first. Captures stay PENDING in the chosen currency: stop and take O-1 to the owner. Any request to a host other than the constant appears in `provider_calls`: trip the switch, stop, incident (INC-3 if credentials are involved).

## MVP-C: hosted, HTTPS webhooks and refunds

**Goal.** The sandbox app runs 24x7 on one long-lived host with HTTPS; webhooks are verified and only trigger read-backs; operators refund through the API with read-back proof; operations are observable and recoverable.

**Modules.** `paypal/webhook-verify`, refund calls, `payments` webhook and refund flows, operator console with TOTP, alerts and metrics, `/healthz`, backups and `tools/export-sql`, deploy config.

**Slices.** Architecture 3 step 17, 7 (cert host), 8 (backups), 9.1 webhook, 9.5 refunds, 9.8 operator MFA, 13.

**User-visible result.** Judges can open the hosted demo any time; a refund requested through the help page is decided by an operator, executed at PayPal and shown on the receipt only after read-back; access ends for refunded online items, and keep items say links have stopped and the downloaded copy cannot be recalled.

**Acceptance tests:**

| Name | Expected result |
|---|---|
| C-01 `webhook_genuine` | A real sandbox delivery verifies and enqueues one read-back; it never sets paid by itself |
| C-02 `webhook_forged` | Forged signature, one changed byte, wrong webhook id, re-serialised body: 400, audit row, no state change (P1) |
| C-03 `webhook_cert_offlist` | `paypal-cert-url` on a non-allow-listed host: 400 without any outbound fetch (P1) |
| C-04 `webhook_cert_unreachable` | Allow-listed cert cannot be fetched: 503, not recorded as forgery |
| C-05 `webhook_replay` | Same event three times: one read-back enqueue, 200 each (P2); replay after a refund leaves access revoked |
| C-06 `refund_full_and_partial` | Partial refund then the remainder: two refund rows, two ledger entries keyed by refund id, read-back REFUNDED; double click gives one refund; over-refund refused locally (P9) |
| C-07 `refund_revokes` | Full refund verified: online item revoked; keep item links stop; receipt version 2 shows the refund |
| C-08 `operator_mfa` | Operator routes without TOTP: 403; with it: allowed; idle 30 min ends the session |
| C-09 `headers_and_limits` | HSTS, CSP nonce, frame-ancestors none, nosniff, Referrer-Policy; body over 64 KB 413; rate limits per nfr.md COST-3 return 429 |
| C-10 `restore_drill` | Restore the latest PGlite dump to a fresh host within 30 min; logical export restores into stock Postgres; orders match PayPal read-backs (REL-5, REL-7) |
| C-11 `restart_mid_capture` | `kill -9` during capture: after restart the order reaches a terminal or frozen state within 2 reconciler passes (REL-2) |
| C-12 `race_webhook_poller` | Webhook and poller on one order at once: one transition, one sale |
| C-13 `uptime` | External check on `/healthz` and one buyer page every 5 min, alerting both operators |

**Gates.** nfr.md MVP-C list: SOP 4 (operator MFA), 5, 8, 9, 10, 14, 17, 18, 20 (ZAP baseline by Sakthi), 21; P1, P2, P8, P9; restore drill; runbook dry run INC-1 to INC-4; PERF-1, PERF-4, PERF-6 to PERF-9; REL-1, REL-5, REL-7, REL-8; OBS-4 to OBS-6; COST-1, COST-3, COST-4; RLR-1 to RLR-3, RLR-5; A11Y-1 to A11Y-7; COMP-1.

**Real versus fixture.** Real: C-01, C-06, C-07, C-10, C-13 on the hosted sandbox. Fixture: C-02 to C-05, C-08, C-09, C-11, C-12 (built from a recorded genuine delivery, re-signed in tests with a test cert).

**Dependencies and approvals.** Host chosen (D-6) with a persistent disk; domain and TLS; `PAYPAL_WEBHOOK_ID` created by the owner in the sandbox app; outbound approval scope `mvp_c_refunds` adding refund paths; operator TOTP enrolment by Vikram and Sakthi.

**Lanes** (about 7.5 lane-days, 2 to 3 calendar days):

| Lane | Days | Verify |
|---|---|---|
| C-L1 webhook verification and mapping $ | 1.5 | Opus |
| C-L2 refunds and refund read-back $ | 1.5 | Opus |
| C-L3 deploy, backups, export-sql, restore drill | 1.5 | Opus (data) |
| C-L4 operator console and TOTP | 1 | Opus |
| C-L5 health, metrics, alerts | 1 | gates |
| C-L6 accessibility and Core Web Vitals pass | 1 | gates |

**Stop conditions.** A forged or replayed webhook changes state; a refund changes money without a read-back; the host cannot keep one process with a persistent disk (then stay laptop-hosted for demos and take the hosting choice back to the owner).

## MVP-D: two publishers (composite)

**Goal.** One buyer approval over items from two publishers, settled as separate merchant transactions; partial outcomes are clear and recoverable; no automatic substitution; mixed currency rejected.

**Route by spike outcome** (decided D-3: D2 is the default unless the spike proves D1; no commission collection):

| Spike result | Route | Shape |
|---|---|---|
| W11 accepted: an order with a different `payee.merchant_id` per unit works without consent errors | D1 | One PayPal order, one unit per publisher, payee per unit, no platform fee; capture may answer 207 |
| W11 gives `PAYEE_NOT_CONSENTED` or similar | D2 (default) | One PayPal order per publisher under one UnitMarket approval; the buyer approves at PayPal once per publisher, with progress "1 of 2"; the internal order maps to N `provider_orders` |
| Owner obtains partner enablement and wants a platform fee | D3 | D1 plus `payment_instruction.platform_fees` (max one per unit), Partner Referrals onboarding with `PARTNER_FEE`; the fee-receiving account is not a seller |

**Modules.** Snapshot and order for N units; `provider_orders` routing; composite UI; `recovery` kind `partial_composite`; payee onboarding record (P18); per-publisher ledger and reconciliation.

**User-visible result.** A two-publisher pack; if one publisher's capture fails, the buyer sees which item is ready and which is not, is not charged for the failed one, and is offered keep-what-worked (default) or a refund of the captured part; no other article is swapped in.

**Acceptance tests:**

| Name | Expected result |
|---|---|
| D-01 `two_captures` | Two capture ids, one per publisher, visible in the sandbox dashboard; per-item entitlements |
| D-02 `partial_capture` | One unit captured, one declined (fixture, and real if the sandbox can produce it): order `paid_partial`; captured items available; failed item locked and not charged; recovery case opened |
| D-03 `no_substitution` | No other offer is added after a partial failure |
| D-04 `unverified_payee_refused` | A publisher without `payee_verified_at` cannot appear in a snapshot (P18) |
| D-05 `per_unit_match` | Mismatch on one unit freezes that unit only; order-level mismatch freezes the order (P5 per unit) |
| D-06 `ledger_per_publisher` | Ledger sums per publisher equal verified captured minus refunded (P11 per publisher) |
| D-07 `mixed_currency` | Composite with two currencies refused before approval |

**Gates.** nfr.md MVP-D list: SOP 16 if uploads exist; P18; P5 re-run per unit; P11 per publisher.

**Real versus fixture.** Real: D-01 and D-02 where possible. Fixture: the rest.

**Dependencies and approvals.** Two sandbox Business accounts as publishers (the owner decides whether to create them; we assume none); for D3, Partner Referrals approval and an outbound scope that adds its path.

**Lanes** (about 4 lane-days): D-L1 N-unit snapshot, order and routing $ (1.5, Opus); D-L2 composite UI and recovery (1, gates); D-L3 payee onboarding record (0.5, Opus); D-L4 per-publisher reconciliation $ (0.5, Opus); D-L5 fixtures for 207 and partial paths (0.5, Opus).

**Stop conditions.** Neither D1 nor D2 can be exercised in the sandbox by Tue 3 Nov: ship single publisher, keep composite in fixtures, label it.

## MVP-E: WordPress entry path

**Goal.** A publisher's WordPress page shows "Buy through UnitMarket" on an article; the button deep-links to `startFromOffer`; the publisher's offer feed is imported safely. Checkout, rights and payment stay in UnitMarket.

**Modules.** Signed deep link verification in `offer-entry`; feed import with SSRF guards; a small PHP plugin (separate folder `integrations/wordpress/`, no PHP inside the Node packages); a demo publisher site with a fictional brand (owner hosts).

**Acceptance tests.** E-01 `signed_link`: valid HMAC link opens the same approval screen as the direct path; a changed byte, an expired link or a price parameter in the URL is refused or ignored (price always from our catalogue). E-02 `feed_ssrf`: feed URLs `169.254.169.254`, `localhost`, a redirect to `10.0.0.1`, http scheme, more than 2 MB, more than 5 s: refused (P19). E-03 `feed_sanitised`: HTML in feed text stored as data and rendered inert. E-04 `injection_rerun`: AI-1 set re-run on imported content.

**Gates.** nfr.md MVP-E list: SOP 16, 18 (SSRF); P19; AI-1 re-run.

**Real versus fixture.** WordPress demo site real (owner-hosted); PayPal unchanged from MVP-B or MVP-D.

**Dependencies.** Owner approves a WordPress host and a fictional brand. Lanes about 3.5 lane-days (E-L1 link 0.5, E-L2 feed 1, E-L3 plugin 1.5, E-L4 demo page 0.5). Stop: if not green by Fri 6 Nov, cut and keep a static "publisher page" inside the app using the same signed link.

## MVP-F: hardening and submission

**Goal.** A judged, honest, stable demo: full SOP report, secrets rotated, video, README with what is real sandbox and what is fixture, judge access.

**Content.** SOP sections 1 to 23 report (nfr.md MVP-F list: SOP 1, 11, 12, 13, 14, 20, 21, 22, 23; secret rotation; ZAP re-run; restore drill; full checklist re-ticked); SUP-2, SUP-3, SUP-5 (SBOM); PRIV-1, PRIV-3 to PRIV-6 (deletion and export scripts); README; video under 3 minutes on real sandbox captures; judge personas behind the passcode; 24x7 runbook until 15 Dec.

**Acceptance tests.** F-01 `clean_clone`: a clean clone runs offline mode from the README alone in under 15 minutes (PAY-12). F-02 `security_report`: zero open critical or high findings. F-03 `honest_readme`: every claim of PayPal behaviour cites a `sandbox-recording` fixture or an official doc; everything else is labelled. F-04 `judge_journey`: a judge completes the offer path and sees a receipt with a sandbox capture id. F-05 `export_delete`: a buyer export and a deletion (receipts pseudonymised) both work.

**Lanes.** About 5 lane-days, mostly Opus review plus owner time. Stop: any critical finding blocks submission until fixed or the feature is switched off by its kill switch.

## Read-only spike runbook (owner or Sakthi only; we never run it)

Purpose: decide currency, composite route and refund evidence before MVP-B. Do it from your own machine, sandbox only. Part R makes no state change. Part W creates sandbox orders with play money; it is still an outbound call, so run it only if you approve it separately.

Recording rules for every step: keep HTTP status, response headers named `paypal-debug-id` (record the exact header name you see), body `name`, `issue`, `debug_id`, statuses, link `rel` values and hosts. Redact before saving: access token, client id and secret (never copy them), `nonce`, payer email, payer name, `payer_id`, addresses, phone; merchant ids to the last 4 characters; order and capture ids to the last 6 for documents. Save as `NN-step.json` plus one line in a summary.

Part R (read-only):

1. Dashboard: confirm the REST app "Default Application" is sandbox; record enabled features (leave Payouts unticked and unsaved).
2. Sandbox accounts: for DE Business and DE Personal record country, account type, currencies held, and the Business account's payment receiving preference for currencies it does not hold. Change nothing.
3. Token: `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`. Record status, `expires_in`, `token_type`, and the scope list (note whether payouts appears).
4. Not-found read: `GET /v2/checkout/orders/AAAAAAAAAAAAAAAAA`. Record 404 body `name`, `issue`, `debug_id` and the debug header name.
5. Webhooks page: record whether any webhook is registered (expected none).

Part W (sandbox writes, separate approval):

6. Create a one-unit USD order, no payee, `Prefer: return=representation`, `PayPal-Request-Id: spike-K1`, with `payment_source.paypal.experience_context` (return and cancel URLs of `https://example.invalid/...`). Record status code, order status, link rels and the approval link host, echoed `reference_id`, `custom_id`, `invoice_id`, and whether `payee` is echoed.
7. Repeat step 6 with the same key: same order id? status code?
8. `GET` the order before approval: status, payee, amounts.
9. Capture before approval with `spike-K2`: expect 422 `ORDER_NOT_APPROVED`; record body.
10. Approve in a browser as the sandbox buyer; `GET`: expect `APPROVED`.
11. Capture with `spike-K3`: record code, capture status, `status_details.reason`, `seller_receivable_breakdown`, payee. Repeat with `spike-K3`: expect 200 and the same capture. Capture with `spike-K4`: expect 422 `ORDER_ALREADY_CAPTURED`.
12. `GET` the order and `GET /v2/payments/captures/{id}`: record every field our mapping uses.
13. If step 11 was `PENDING`: record the reason; repeat steps 6 to 12 in EUR for comparison only.
14. Refund 1.00 with `spike-K5`, then the remainder with an empty body and `spike-K6`. `GET` each refund, the capture and the order: record statuses, refunded totals and whether refunds carry an `up` link to the capture.
15. Create a two-unit order for the same payee (`reference_id` A and B); approve; capture: record 201 or 207 and per-unit fields.
16. Only if you have created a second Business account: create an order whose unit payee is that account's merchant id; record success or `PAYEE_NOT_CONSENTED`.
17. Leave one order approved and uncaptured; capture it about 3 h later, and another about 7 h later with the key used for a failed earlier attempt; record outcomes (order validity and key retention).
18. After hosting (MVP-C) only: register a webhook, trigger one capture, and record the `paypal-cert-url` host and path.

Not in the spike: Partner Referrals, Payouts, any live call.

## Spike kit design (offline script; it runs only when the owner sets variables locally; we will not run it)

- Location `tools/spike-kit/` in SBX; one TypeScript file run with Node 22 type stripping; no dependencies; its own copy of the sandbox host constant and a path allow-list limited to the runbook calls (it does not import product packages, so it can exist before MVP-A ends).
- Refuses to start unless: `SPIKE_OPERATOR` is `vikram` or `sakthi`; `SPIKE_APPROVAL_REF` names a decision-log row; `SPIKE_MODE` is `read` or `write`; `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are in the process environment (never read from a file in the repo); stdin is a TTY; `CI` is unset. Any value containing `live` or a non-sandbox host exits.
- Each step prints what it will send (with secrets masked) and asks `y/N`; `write` steps ask twice. Hard cap of 40 calls per run; no automatic retries.
- Token kept in memory only; never printed.
- Output to `~/unitmarket-spike/<date>/` outside any repository: redacted JSON per step and `summary.md` in the runbook's order; redaction by key and by pattern, with a self-test that fails the run if a canary survives.
- `--dry-run` replays the bundled `docs-example` fixtures through the same code; that mode is the only one the AI builders run, and it has a CI test.
- The owner copies chosen outputs into `fixtures/paypal/sandbox-recordings/` through a reviewed PR with the source label.

## Totals

About 48 lane-days across MVP-A to MVP-F (A 21, B 7.5, C 7.5, D 4, E 3.5, F 5), with 6 to 8 Sonnet workers and Opus verification on every money lane. The bottleneck is the owner's sandbox time (about 8 hours in total) and the four decisions on Mon 26 Oct.

Simulation proves modelled cases only, not PayPal compatibility.
