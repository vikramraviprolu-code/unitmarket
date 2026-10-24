# MVP-C owner notes

## Operator TOTP keys

- Where keys live: only in the host settings (`UMS_OPERATOR_TOTP_KEYS`) and in each operator's own
  `.env.local`. Never in the cloud session environment. A coordinating AI session that could read a key
  could mint mfa codes, and mfa gates refunds and switch-on.
- Who enrols: Vikram and Sakthi each run `corepack pnpm totp:enrol --operator <name>` on their own
  machine, in their own terminal (it refuses without a TTY, in CI and in an AI session). Add the printed
  `<name>:<secret>` to your own `.env.local` and to the host settings, scan the URI into your
  authenticator app, then clear the terminal scrollback. Never paste the secret or the URI anywhere else.
- After removing an operator's key: run `revokeAllSessions` for that operator, or rotate
  `UMS_SESSION_SECRET` (that ends every session). Removing the key alone does not end a session that is
  already signed in.
- A lockout caused by someone who holds the demo passcode (they fill the per-operator failure bucket,
  5 wrong codes per 15 minutes) is cleared by rotating `UMS_DEMO_PASSCODE_HASH`.
