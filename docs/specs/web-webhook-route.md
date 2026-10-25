# CO-3: the public webhook route

Task: add `POST /api/webhooks/paypal`, which reads the raw body, verifies it through the adapter, and hands the verdict to payments intake.
Package: `apps/web` (route, composition), `packages/security` (`route.ts`, raw-body option) Owner: Sonnet 5.5 builder, effort high (public, money-adjacent route) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W4, after CO-1, CO-2 and CO-6 merge (composition is held by one lane at a time). Assumptions: ASM-51, ASM-54, ASM-60. Requirements: nfr.md P1, P2, SOP 5, 8, 9, COST-3 (invalid webhook 60 per min per IP, valid never limited), RLR-5.

Goal: the route is `withRoute({ auth: 'webhook', csrf: false, maxBody: 65536, raw: true, rate: 'webhook_invalid' }, handler)`. If `withRoute` cannot pass the raw text, add a `raw: true` option to `packages/security/src/route.ts` that hands `{ raw_body: string, headers }` without JSON parsing and keeps every other check (size, method, headers); every answer other than 200 is charged to the bucket, the switched-off 503 included (see Amendment CO-3b). Composition adds `engine.webhook({ headers, raw_body })`: `paypal.verifyWebhook` then `handleWebhook`. `AdapterDeps.webhook_id` comes from `config.webhook_id` (`PAYPAL_WEBHOOK_ID`, already read by config). The certificate fetch goes through the approved transport, so it needs scope `mvp_c_refunds` (ASM-51); under `mvp_b_polling` the fetch is blocked and the route answers 503, which PayPal retries. Answers carry an empty JSON body; no event data is echoed; the raw body and signature are never logged. In tests, `AppOptions.webhook_certificates` (accepted only when `node_env` is `test`) injects a certificate source.

Inputs: CO-1 (`verifyWebhook`, `CertificateSource`), CO-2 (`handleWebhook`), `packages/security/src/route.ts`, `scripts/route-inventory.mjs`, `apps/web/composition.server.ts`.

Outputs: `packages/paypal/src/index.ts` (one line re-exporting `EXPECTED_CERT_SUBJECTS`: rule S1 bars a subpath import), `apps/web/src/app/api/webhooks/paypal/route.ts`, `apps/web/composition.server.ts` (wiring lines and `engine.webhook`; behaviour lives in a new `apps/web/src/server/webhook.ts`), `packages/security/src/route.ts` (if needed) and its test, the reviewed route list entry, tests below.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project state apps/web/src/webhook.state.test.ts`: verdict to answer table (verified 200, duplicate 200, bad_signature 400, malformed 400, unverifiable 503, disabled 503); `61 invalid deliveries from one address in a minute: the 61st is 429`; `600 valid deliveries in a minute: none limited`.
- `corepack pnpm vitest run --project integration apps/web/src/webhook.integration.test.ts`: through the route handler with an injected certificate source and a runtime key pair: a signed delivery enqueues one read-back; the same delivery again answers 200 and enqueues nothing; under `mvp_b_polling` with no injected source the answer is 503 and nothing is stored.
- `corepack pnpm vitest run --project adversarial apps/web/src/webhook.adversarial.test.ts`: body of 64 KiB plus 1 byte gives 413; GET gives 405; a non-JSON content type with a valid signature over that body still verifies (the signature, not the header, decides) but an unparsable body is 400; no log line contains the body, the signature or the transmission id in clear; `webhook_certificates` outside `node_env` test refuses boot.
- `corepack pnpm check:routes`: the route is listed with auth `webhook` (no session), CSRF off, body cap 64 KiB.
- `corepack pnpm run ci`: exit 0.

Do not: verify with the postback API; let a webhook set paid or touch the ledger; read the body before the size check; log request bodies; change CO-1 or CO-2 behaviour (a needed change is a stop-and-report); touch other routes; add a dependency.

Evidence for the PR: red summary; pass counts; the route inventory diff; a statement of what is still unverified until a real delivery (ASM-54).

Branch: `feat/web-webhook-route` Commit: `feat(web): verified PayPal webhook route that only enqueues read-backs (CO-3)`

Review notes (CO-1 and CO-2 reviews, 2026-10-23):

- Check `webhook_enabled` BEFORE calling `verifyWebhook`, so a disabled webhook triggers no certificate fetch.
- Rate-limit every non-200 answer per IP, including 503 `unverifiable`, not only 400s: a refused delivery writes one append-only `audit_log` row (300 bad deliveries gave 300 rows), and a cert-failure `unverifiable` costs a certificate fetch. Also count cert-failure `unverifiable` in the same limiter. That limiter keeps the audit log from filling; it does not protect the certificate fetch budget (6 posts an hour is under any per-IP limit, and an attacker can use many addresses). The certificate source protects it: trusted URLs, those that have verified a delivery, have a reserved budget and unknown URLs are capped at 1 an hour and 12 a day once any URL is trusted (CO-1b). Each trusted URL has its own 1 an hour and 4 a day (CO-1c); the worst case is 28 calls a day. Alert on webhook silence (no verified delivery for longer than expected): a certificate rotation during a sustained attack stays unverifiable until the attack stops or the owner updates the pin (ASM-64).
- Give certificate fetches their own safety budget so they can never starve money operations (CO-1 header).
- Read raw bytes, cap at 64 KiB while streaming, decode with `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`.
- Refuse `webhook_enabled=on` in sandbox mode while the certificate pin (ASM-64) is empty, and while `webhook_id` is unset.

Amendment CO-3b (Opus review of CO-3, 2026-10-24):

- Auth is `webhook`, not `public`: `public` with POST needs CSRF and reads the session cookie, which a webhook has neither of.
- The acceptance command is `corepack pnpm run ci` (pnpm has no `ci` command of its own).
- The one-line re-export of `EXPECTED_CERT_SUBJECTS` in `packages/paypal/src/index.ts` is an Output (rule S1 bars a subpath import).
- Every non-200 answer is charged to the limiter, the 503 for a switched-off webhook included; there is no opt-out.
