# Threat model (one page)

Status: draft 1, 30 Oct 2026 (DOCS-A). Scope: the PayPal sandbox track only. It restates controls that exist in the design and the code; where a control is not written down anywhere it says `missing`; anything not checked in code on this date says UNVERIFIED. A passing test proves the modelled case only, not PayPal compatibility.
Sources: `architecture.md` 2.1, 7, 9.8, 13 (row 21 asked for this document); `nfr.md` (P1 to P19, AI-1 to AI-5, PRIV, SOP, section 5); `docs/decision-log.md` D-028, D-029, D-040, D-041, D-045, D-059, D-061, D-063; the overnight specs in `docs/specs/` for section 6. Specified lanes are not built until merged.

## 1. Assets

| Asset | Where it lives | Source |
| --- | --- | --- |
| Payee destination (publisher merchant id, our own sandbox merchant id) | `publishers.paypal_merchant_id`, config; payee guard in migration 0010 | D-028, D-041, nfr P18 |
| Approval rows and outbound approvals | `approvals` (only `used_at` may change), `outbound_approvals` (append-only) | architecture 7.5, migrations 0004, 0006 |
| Sandbox credentials | cloud environment variables and the owner's local env file, read only by `packages/config` | D-029, CLAUDE.md rules 1 and 4 |
| Session, approval and link secrets, passcode hashes, operator TOTP keys | host secret store, owner's local env file | D-040 (1), D-061, D-063 |
| Buyer data (display name, briefs, consents, access events) | `buyers`, `briefs`, `consents`, `access_events`; no card data | nfr PRIV-1 |
| Content | `articles`, `content_blobs`, served through an authorised route | nfr P13, P14 |
| Ledger and receipts | append-only tables, the evidence for every money statement | nfr P12, migration 0004 |

## 2. Actors

Buyer. Publisher persona holder. Operator (Vikram, Sakthi). Coordinating AI session (may use the owner's sandbox credentials only through the sealed transport and the five locks, D-029). Builder agents (hold no credentials, CLAUDE.md rule 1). PayPal (a sender of webhooks and a source of read-backs, not trusted for state without a read-back). Hosting provider (sees the host settings and disk). Anonymous attacker.

## 3. STRIDE, one row per threat

| # | Type | Threat | Control | Pinned by |
| --- | --- | --- | --- | --- |
| 1 | S | Forged or altered payment webhook | P1: signature over the raw body; webhook only enqueues a read-back | `packages/paypal/src/webhook-verify.adversarial.test.ts`, `apps/web/src/webhook.adversarial.test.ts` |
| 2 | S, I | Attacker sets the certificate URL to their own host (SSRF) | host allow-list checked before any fetch | `packages/paypal/src/webhook-cert.adversarial.test.ts` |
| 3 | R | Old genuine webhook replayed | P2: unique event id; the read-back decides state | `domain/payments/src/webhooks.adversarial.test.ts` |
| 4 | T | Buyer edits price, payee or amount | P5: order built server-side from the database, snapshot match, any mismatch freezes | `domain/payments/src/freeze.mismatch.state.test.ts`, `domain/approval/src/approval.adversarial.test.ts` |
| 5 | T | Return with a foreign order id, or a return fired by a prefetch or an image | P6, P10: stored order id, single-use token, only a page navigation starts the return | `apps/web/src/server/return-guard.test.ts`, `domain/payments/src/return.state.test.ts` |
| 6 | I | Buyer reads another buyer's order, receipt, library item or content | actor in every query, 404 for another buyer's id (no existence oracle), P13 | `domain/library/src/library.adversarial.test.ts`, `domain/delivery/src/delivery.adversarial.test.ts`, `domain/receipts/src/receipts.adversarial.test.ts` |
| 7 | D, T | Double click or retry storm causes a second capture | P3 request ids, P4 conditional transition, row lock | `domain/payments/src/lockorder.state.test.ts`, `tests/mvp-c/c12-race.integration.test.ts`; real Postgres races waived (section 5) |
| 8 | E | Stolen operator session issues refunds | operator TOTP, 30 min idle, refund cap, `refunds_enabled` | `packages/security/src/totp.adversarial.test.ts`, `apps/web/src/refund.adversarial.test.ts` |
| 9 | T | Prompt injection in article text or a brief adds items or changes a price | AI-1, AI-3, AI-5: untrusted output, ids re-resolved, price and payee from the database | `packages/model/src/scripted.adversarial.test.ts`, `domain/discovery/src/discover.adversarial.test.ts` |
| 10 | I | Secret reaches a log or the client bundle | redaction in logger and `provider_calls`, server-only config, gitleaks; bundle scan `check:bundle` is not in the `ci` script, UNVERIFIED that anything runs it before release | `tests/mvp-b/b09-logs-clean.integration.test.ts`, `scripts/log-scan.test.ts` |
| 11 | S | Config drift points at live PayPal | P15 fail closed, no live value, no live host string | `packages/config/src/config.test.ts`, `scripts/check-no-live-host.test.ts` |
| 12 | E | A script, agent or caller reaches PayPal around the locks | two-key approval, sealed transport, egress guard, kill switches | `tests/mvp-b/unseal.adversarial.test.ts`, `packages/safety/src/seal.adversarial.test.ts`, `packages/transport/src/sandbox.adversarial.test.ts` |
| 13 | T | Ledger or receipt rewritten | P12: triggers refuse UPDATE, DELETE, TRUNCATE | `domain/ledger/src/ledger.adversarial.test.ts`, `packages/db/src/schema.state.test.ts` |
| 14 | S, D | Passcode guessing; lock-out of an operator | 5 tries per 15 min per address; accepted risk D-040 (2) | `packages/security/src/lockout.state.test.ts`, `apps/web/src/lockout.state.test.ts` |
| 15 | T | CSRF or mass assignment on a state-changing route | Origin check, token, zod `.strict()` | `packages/security/src/route.adversarial.test.ts` |
| 16 | I | Script injected through content or model text | CSP with nonce, text rendering. Gap: the policy has no `style-src`, so `default-src 'self'` would block inline `style` attributes that exist in `WindowMeter.tsx`, `RefundPanel.tsx`, `library/page.tsx`; UNVERIFIED in a browser | `packages/security/src/headers.test.ts`, `apps/web/src/web.adversarial.test.ts` |
| 17 | D | Request floods; a bad deploy mid-sitting | rate limits per route, body caps, maintenance mode | `packages/security/src/rate.state.test.ts`, `apps/web/src/maintenance.adversarial.test.ts` |
| 18 | T | Simulation code or scope enters this repository | `check:isolation`, lint | `scripts/check-isolation.test.ts`, `tests/mvp-a/isolation-a20-a21.adversarial.test.ts` |
| 19 | I | Operator command hits the wrong database because the terminal holds old settings (D-059) | `env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT` prefix; `safety:status` prints `db=`. The code guard is on branch `feat/config-env-file-guard`, not on `main` | none on `main`: missing |
| 20 | I | A secret is pasted into chat or a document (D-061, D-063) | rotate within the hour, paste only the lines asked for | none: a process rule only, missing |
| 21 | R | An operator action is denied later | append-only `audit_log` with actor and reason | `packages/obs/src/obs.test.ts` |

## 4. Zones

Zones Z0 to Z7 and their allowed reach are in `architecture.md` 2.1. The only egress is Z4. The model adapter of section 6 adds a second egress host, which architecture section 1 ("No Claude API") and Z4 do not yet allow.

## 5. Accepted risks

1. Shared demo passcode: anyone holding it can lock an operator out of sign-in for up to 15 minutes; rotate `UMS_DEMO_PASSCODE_HASH` (D-040 (2)).
2. Real Postgres race tests (ASM-55) waived for the MVP-C sitting only (D-040 (4), D-045). They are due again, or a new waiver, before the app stays up for judging. Whether either exists today: UNVERIFIED.
3. Single merchant: both publishers are paid into the owner's one sandbox account; multi-merchant payout is not demonstrated (D-041).
4. From `nfr.md` section 5: no buyer MFA, no RLS on PGlite, no blocking CI while the repository is private, no 24x7 on-call, no third party penetration test.

## 6. New surfaces from the overnight lanes (specified, not built)

| Surface | Controls in the spec | Gaps |
| --- | --- | --- |
| Publisher personas (`pub-a1-personas-shell.md`) | separate publisher passcode hash; the demo hash never signs a publisher in; every query filters by `publisher_id`; another publisher's id answers 404 | three personas share one passcode, so a holder can sign in as any publisher; no decision row accepts this yet |
| Payee requests (`pub-a2-payee.md`) | a publisher can only request; an operator with TOTP retypes the full id; hosted mode refuses (`owner_command_required`, D-062); last 4 only in audit and logs; 3 requests per day | a payee verified while an approval is open must make the order answer `payee_unavailable`; if it does not, it is a money path finding |
| Model egress host (`ai-a-model-adapter.md`) | one host constant, one path, POST only, no redirects, 64 KB and 256 KB caps, 20 s deadline; key as a `Secret`; spend caps USD 2 per day and 20 in total; scripted fallback; ships off | the decision row amending architecture section 1 is a stated prerequisite, not yet recorded; the PRIV-2 test on the prompt builder is not in the spec's test list, `missing` |
| Appearance cookie (`skin-a-system.md`) | `um_skin` holds `market` or `harbour` only, any other value renders `market`; HttpOnly, Secure, SameSite=Lax; route is CSRF checked, strict body, 30 per minute per address | the privacy notice of `legal-a-pages.md` names the session cookie only, `missing` for this cookie; no `__Host-` prefix |

Also specified: offer versions freeze the approved price (`pub-b`), sales and statements read the ledger only (`pub-c`), suspend by an operator with TOTP (`pub-d`), the reader renders text nodes only (`reader-a`).
