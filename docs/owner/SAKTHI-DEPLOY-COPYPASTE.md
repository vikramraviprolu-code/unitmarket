# Deploy to Google Cloud: moved

The copy and paste guide for Sakthi is replaced by one short runbook and one command kit (INT-CL1).

- Read `docs/owner/CLOUD-RUNBOOK.md`.
- To deploy a reviewed tag, check it out in a clean clone and run `corepack pnpm cloud:deploy TAG` (add `--dry-run` first).
- Nothing in the kit turns PayPal on. Every deploy leaves `UMS_PAYPAL_CONNECT` off.

The full reference for the hosted set-up is still `docs/owner/DEPLOY-PREP-2026-11.md`. The earlier version of this guide (the `gcp-pub-1` steps for commit `e7560e7`) is in the git history.
