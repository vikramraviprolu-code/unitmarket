# CO-1: webhook self-verification in the PayPal adapter

Task: replace the always-`unverifiable` stub with local signature verification over the raw body, with a certificate-URL allow-list checked before any fetch, a validity check and a small cache.
Package: `packages/paypal` Owner: Sonnet 5.5 builder, effort high (P1: a forgery here is free content) Reviewer: Opus 5.5 high, mutation check on `webhook-verify.ts`; Sakthi merges
Wave: W0, starts now. Assumptions: ASM-54 (new), ASM-07, ASM-33. Requirements: nfr.md P1, P2 (dedupe is CO-2), architecture 9.1.

Goal: `verifyWebhook({ headers, raw_body })` returns a `WebhookVerdict` (contract unchanged) in this order: raw body over 64 KiB, a missing or duplicated (case-insensitive) one of `paypal-transmission-id`, `-time`, `-sig`, `-cert-url`, `-auth-algo`, or an unparsable time gives `malformed`. `paypal-auth-algo` other than `SHA256withRSA` gives `bad_signature('algo')`. The cert URL must pass the same rule as the transport guard (https, no port, no userinfo, no query, one host label under `sandbox.paypal.com`, path under `/v1/notifications/certs/`); otherwise `bad_signature('cert_url')` with no fetch at all. Transmission time outside [now minus 3 days 1 h, now plus 5 min] gives `bad_signature('stale')`. `webhook_id` not configured gives `unverifiable`. The certificate comes from a `CertificateSource` port: production fetches the PEM through the Transport as `fetch_webhook_cert` (so all locks apply) and parses it with `X509Certificate`; a fetch failure, a parse failure or a certificate outside its validity dates gives `unverifiable` (503, never recorded as a forgery). The signed message is `<transmission id>|<transmission time>|<webhook id>|<crc32 of the raw bytes, unsigned decimal>`; it is checked with `createVerify('SHA256')` against the certificate's public key and the base64 signature; a mismatch gives `bad_signature('signature')`. Only after a valid signature is the body parsed as JSON and checked with `ProviderEventSchema`; a failure gives `malformed`. Certificates are cached by URL until the earlier of `validTo` and 24 h, at most 8 entries. An expected certificate subject list is a config-free constant, empty for now: when empty the subject is logged, not checked (recorded on the first owner run, then pinned).

Inputs: `packages/paypal/src/{webhook-verify.ts, adapter.ts}`, `packages/contracts` `WebhookVerdict`, `ProviderEventSchema`, `packages/transport` (`fetch_webhook_cert`, guard rule), `node:crypto` (`createVerify`, `X509Certificate`), architecture 9.1, nfr.md P1.

Outputs: `packages/paypal/src/{webhook-verify.ts, crc32.ts, webhook-cert.ts}`, `adapter.ts` (`verifyWebhook` wiring; `AdapterDeps.webhook_id: string | null` and an optional `certificates` source), `fixtures/paypal/webhooks/synthetic/*.json` (body and header skeletons, `label: synthetic`; signatures are made in the tests with a key pair generated at run time, so no private key is ever committed), one public test certificate PEM (`fixtures/paypal/webhooks/synthetic/parse-only.pem`, its key discarded, used only for parsing and date tests), `scripts/check-fixtures.mjs` (accepts the webhooks folder).

Order: commit 1 is tests and fixtures only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit packages/paypal/src/crc32.test.ts packages/paypal/src/webhook-cert.test.ts`: CRC32 of `123456789` is 3421780262; empty input 0; the PEM fixture parses; dates outside validity refuse; cache keeps 8 and expires at the earlier bound.
- `corepack pnpm vitest run --project contract packages/paypal/src/webhook-verify.contract.test.ts`: every synthetic fixture, signed at run time, verifies to `verified` with the expected event type and resource id.
- `corepack pnpm vitest run --project golden packages/paypal/src/webhook-message.golden.test.ts`: the signed-message string per fixture matches the golden file.
- `corepack pnpm vitest run --project adversarial packages/paypal/src/webhook-verify.adversarial.test.ts`: forged signature, one changed body byte, wrong webhook id, re-serialised body (`JSON.stringify(JSON.parse(raw))`), algorithm `SHA1withRSA`: `bad_signature`; cert URLs with an `http` scheme, with port 8443, on a host where the sandbox domain is followed by another suffix, two labels deep under the sandbox domain, with userinfo, with `..` in the path, with a query (tests build these host names from parts at run time, as other test files do): `bad_signature` with 0 transport calls; cert fetch blocked or 500: `unverifiable`; body of 64 KiB plus 1 byte: `malformed`; two `paypal-transmission-sig` headers differing in case: `malformed`.
- `corepack pnpm mutation --targets packages/paypal/src/webhook-verify.ts --require-targets`: at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm check:fixtures && corepack pnpm check:no-live-host`: exit 0.

Do not: call the postback API (`verify_webhook_postback`); fetch a certificate outside the Transport; commit a private key; parse the body before the signature check; log the raw body or the signature; touch `domain/*`, `apps/*` or the contracts; add a dependency.

Evidence for the PR: red summary; pass counts; mutation score; a list of what stays unverified until a real delivery (header names, algorithm value, cert host and subject, time format).

Branch: `feat/paypal-webhook-verify` Commit: `feat(paypal): webhook self-verification with cert allow-list and cache (CO-1)`
