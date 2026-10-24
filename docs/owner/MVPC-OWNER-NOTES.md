# MVP-C owner notes

## Operator TOTP keys

- Where keys live: only in the host settings (`UMS_OPERATOR_TOTP_KEYS`) and in each operator's own
  `.env.local`. Never in the cloud session environment. A coordinating AI session that could read a key
  could mint mfa codes, and mfa gates refunds and switch-on.
- Who enrols: Vikram and Sakthi each run `corepack pnpm totp:enrol --operator <name>` on their own
  machine, in their own terminal (it refuses without a TTY, in CI and in an AI session). Add the printed
  `<name>:<secret>` to your own `.env.local` and to the host settings, scan the URI into your
  authenticator app, then clear the terminal scrollback. Never paste the secret or the URI anywhere else.
- After removing an operator's key: rotate `UMS_SESSION_SECRET` (that ends every session). No command
  calls `revokeAllSessions` yet, so rotating is the only step the owner can take. Removing the key alone
  does not end a session that is already signed in.
- A lockout caused by someone who holds the demo passcode (they fill the per-operator failure bucket,
  5 wrong codes per 15 minutes): rotate `UMS_DEMO_PASSCODE_HASH` to stop it. Sign-in works again as the
  bucket refills (one try per 3 minutes, full after 15 minutes); a right code cannot clear a locked
  bucket.
