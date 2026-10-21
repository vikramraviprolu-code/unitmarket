# Design baseline (snapshot, 21 Oct 2026)

Read-only copies of architecture.md, mvp-plan.md and nfr.md as handed to lane 00. Later changes
go through specs and the decision log, not by editing these files silently.

This folder is the ONE allow-listed docs folder for live PayPal hostnames: the design documents
name them in order to forbid them. `scripts/check-no-live-host.mjs` skips `docs/design/` and
nowhere else. No code, fixture or config file may contain them.
