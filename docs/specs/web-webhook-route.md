# CO-3: the public webhook route

Task: add `POST /api/webhooks/paypal`, which reads the raw body, verifies it through the adapter, and hands the verdict to payments intake.
Package: `apps/web` (route, composition), `packages/security` (`route.ts`, raw-body option) Owner: Sonnet 5.5 builder, effort high (public, money-adjacent route) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W4, after CO-1, CO-2 and CO-6 merge (composition is held by one lane at a time). Assumptions: ASM-51, ASM-54, ASM-60. Requirements: nfr.md P1, P2, SOP 5, 8, 9, COST-3 (invalid webhook 60 per min per IP, valid never limited), RLR-5.

Goal: the route is `withRoute({ auth: 'public', csrf: false, maxBody: 65536, raw: true, rate: 'webhook_invalid' }, handler)`. If `withRoute` cannot pass the raw text, add a `raw: true` option to `packages/security/src/route.ts` that hands `{ raw_body: string, headers }` without JSON parsing and keeps every other check (size, method, headers); the rate bucket is charged only when the answer is 400. Composition adds `engine.webhook({ headers, raw_body })`: `paypal.verifyWebhook` then `handleWebhook`. `AdapterDeps.webhook_id` comes from `config.webhook_id` (`PAYPAL_WEBHOOK_ID`, already read by config). The certificate fetch goes through the approved transport, so it needs scope `mvp_c_refunds` (ASM-51); under `mvp_b_polling` the fetch is blocked and the route answers 503, which PayPal retries. Answers carry an empty JSON body; no event data is echoed; the raw body and signature are never logged. In tests, `AppOptions.webhook_certificates` (accepted only when `node_env` is `test`) injects a certificate source.

Inputs: CO-1 (`verifyWebhook`, `CertificateSource`), CO-2 (`handleWebhook`), `packages/security/src/route.ts`, `scripts/route-inventory.mjs`, `apps/web/composition.server.ts`.

Outputs: `apps/web/src/app/api/webhooks/paypal/route.ts`, `apps/web/composition.server.ts` (wiring lines and `engine.webhook`; behaviour lives in a new `apps/web/src/server/webhook.ts`), `packages/security/src/route.ts` (if needed) and its test, the reviewed route list entry, tests below.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project state apps/web/src/webhook.state.test.ts`: verdict to answer table (verified 200, duplicate 200, bad_signature 400, malformed 400, unverifiable 503, disabled 503); `61 invalid deliveries from one address in a minute: the 61st is 429`; `600 valid deliveries in a minute: none limited`.
- `corepack pnpm vitest run --project integration apps/web/src/webhook.integration.test.ts`: through the route handler with an injected certificate source and a runtime key pair: a signed delivery enqueues one read-back; the same delivery again answers 200 and enqueues nothing; under `mvp_b_polling` with no injected source the answer is 503 and nothing is stored.
- `corepack pnpm vitest run --project adversarial apps/web/src/webhook.adversarial.test.ts`: body of 64 KiB plus 1 byte gives 413; GET gives 405; a non-JSON content type with a valid signature over that body still verifies (the signature, not the header, decides) but an unparsable body is 400; no log line contains the body, the signature or the transmission id in clear; `webhook_certificates` outside `node_env` test refuses boot.
- `corepack pnpm check:routes`: the route is listed as public, CSRF off, body cap 64 KiB.
- `corepack pnpm ci`: exit 0.

Do not: verify with the postback API; let a webhook set paid or touch the ledger; read the body before the size check; log request bodies; change CO-1 or CO-2 behaviour (a needed change is a stop-and-report); touch other routes; add a dependency.

Evidence for the PR: red summary; pass counts; the route inventory diff; a statement of what is still unverified until a real delivery (ASM-54).

Branch: `feat/web-webhook-route` Commit: `feat(web): verified PayPal webhook route that only enqueues read-backs (CO-3)`
