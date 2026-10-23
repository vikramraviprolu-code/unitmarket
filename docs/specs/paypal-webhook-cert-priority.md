# Spec: certificate fetch priority for known URLs (CO-1b)

Task: stop a low-rate attacker from denying the webhook channel for days by spending the certificate fetch budget (CO-1 re-review M1, probe R2: 78 legitimate attempts over 3 days, none verified, 146 approval calls a day burned).
Package: `packages/paypal` (`webhook-cert.ts`, `webhook-verify.ts`) Owner: Sonnet 5.5 builder, effort high (security and budget) Reviewer: Opus 5.5 high; Sakthi merges
Goal: after a signature verifies, its certificate URL becomes trusted. Trusted URLs (at most 4, kept until the certificate's end date or 7 days) get a reserved budget of 2 fetches an hour that unknown URLs can never use. Once any URL is trusted, unknown URLs get 1 fetch an hour plus a daily cap of 12 on unknown fetches, so the burn is at most about 24 calls a day. Cold start (first delivery, certificate rotation) is covered by the owner's first run and by the unknown budget.
Inputs: `webhook-cert.ts`, `webhook-verify.ts`, CO-1 tests; ASM-64.
Outputs: the two files above, tests, and corrected header comments.
Acceptance tests:

- Adversarial: a legitimate certificate is trusted after one verified delivery; then 78 attacker attempts over 3 days at 6 an hour never stop its 24-hour refresh (legit verified at every refresh).
- Adversarial: with a trusted URL, unknown URLs make at most 1 fetch an hour and 12 a day (clock-driven); total approval calls from this path at most 24 a day.
- Cold start: with no trusted URL the CO-1 budget (6 an hour) still applies.
- Unit and state: trusted list bounded at 4, expiry by validTo or 7 days, rotation (a new URL verified) replaces the oldest, restart clears the list.
- A test that uses all 6 slots again after the hour (kills the `fetchTimes.length > 0` mutant).
- Header comments fixed: no "cannot fill 8 slots over any time", no "per-IP limiter keeps the budget from emptying" (6 posts an hour is under any per-IP limit), and "pin the host; known URLs get priority" replaces "tighten to the one certificate URL" (PayPal rotates certificate files). Mirror in the CO-3 notes of `docs/specs/paypal-webhook-verify.md` and `web-webhook-route.md`.

Do not: add a dependency; touch other packages; weaken CO-1 tests.
Evidence for the PR: command output, mutation score on both files.
Branch: `feat/paypal-webhook-cert-priority` Commit: `feat(paypal): trusted certificate URLs get a reserved fetch budget (CO-1b)`
