# Spec: the web import gets its own safety switch (WEB-IMPORT-SW)

Task: stop tying the web import (domain proof "Check my site", feed fetch) to the PayPal outbound switch.
Package: `packages/db` (migration 0035), `packages/contracts`, `apps/web`; tests in `packages/safety`, `packages/jobs`, `scripts`. Owner: builder (Sonnet). Reviewer: other than the author.
Branch: `feat/web-import-switch` Commit: `type(<package>): <what> (WEB-IMPORT-SW)`. Decision: owner approved option A on 9 Nov 2026.

Goal: today `mayFetch` in `apps/web/composition.server.ts` is `!maintenance && switches.isOn('paypal_outbound')`. With PayPal outbound closed (the normal state) a publisher's "Check my site" answers "Imports are paused for now", and `pnpm safety:resume` cannot reopen it (resume needs an active PayPal approval). The import reads a seller's website, never PayPal. After this lane `mayFetch` is `!maintenance && switches.isOn('web_import_enabled')`. A missing or unreadable row is paused (the switch reader already fails closed). `paypal_outbound` is not read by the import path at all. Nothing on the PayPal path changes.

Inputs: `packages/safety/src/switches.ts` (reader, `setSwitch`), `packages/db/migrations/common/0021_mandates.sql` (the pattern: widen the name CHECK, seed a row at `1970-01-01T00:00:00Z`), `packages/contracts/src/ports.ts` (`SwitchNameSchema`), `apps/web/src/lib/ops-home-copy.ts` (switch words), `apps/web/src/lib/switches-view.ts` (Controls toggles).

Behaviour:

- Migration `0035_web_import_switch.sql` (0034 belongs to lane L3; the runner applies every unapplied file in name order with no contiguity or checksum check, so 0035 applies on a database that has not applied 0034, and 0034 applies after it). It drops and recreates `safety_switches_name_check` with the eighth name `web_import_enabled`, and inserts the row OFF (changed_by `seed`, 1970-01-01 stamps). Forward only, no default, no `now()`.
- `SwitchNameSchema` gains `web_import_enabled`. Every list of the switches (composition `SWITCHES`, ops copy, test support records) gains it.
- Dry run only (`config.mode === 'offline'`), same code place and same guard as the `paypal_outbound` seed flip: a row still changed_by `seed` is turned on at boot, because a dry run opens no socket. Sandbox mode never takes this path: the owner turns the switch on from the Controls tab.
- Operator Controls tab: lists and labels the switch ("Website import"), off needs no authenticator code, on needs it and a reason code, both write an audit row `switch.web_import_enabled.on|off`. It has no own control (not in `OWN_CONTROL`).
- `pnpm safety:status` lists it (it prints every `safety_switches` row).

Acceptance tests (commit 1 red, commit 2 green):

- `corepack pnpm vitest run apps/web/src/web-import-switch.state.test.ts`: import allowed with the new switch on and `paypal_outbound` off; paused with it off even when `paypal_outbound` is on; missing row is paused; "Check my site" and the queued run follow the same switch; operator toggle writes the audit row.
- `corepack pnpm vitest run packages/safety/src/web-import-switch.adversarial.test.ts`: the PayPal gate answers `kill_switch` with `paypal_outbound` off whatever the import switch says; turning `paypal_outbound` on still needs an approval ref; resume still refuses without an active approval.
- `corepack pnpm vitest run packages/db/src/migration-0035.state.test.ts`: row exists and is off; the name list is widened and still closed; applies with 0034 absent.
- `corepack pnpm vitest run scripts/safety-cli.test.ts`: `status` prints `switch web_import_enabled=off`.
- Existing tests that list the switches (counts and names) are updated and listed in the PR.

Do not: touch PayPal transport, `packages/paypal`, the approval, resume or connect-flag logic, the `paypal_outbound` semantics, the money path, corridors or migration 0034; add a dependency; put a secret anywhere.
Evidence for the PR: red run, green run, every check output with counts, list of existing tests edited with reasons, the after-deploy owner steps.
