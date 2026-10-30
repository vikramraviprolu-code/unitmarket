# UI options saved on 30 Oct 2026

Design previews, not product code. They use the real catalogue articles and prices and charge nothing.

| File | What it is | Preview link (private, owner shares) |
| --- | --- | --- |
| `results-prototype.html` | One working results page: search, sort, pack tray | https://claude.ai/artifact/K9vidcKb6KUcf6767mGcsS |
| `styles-a-b-c.html` | A Marketplace, B Catalogue, C Checkout first, on the find page and the pack approval page | https://claude.ai/artifact/CGJKnwdZPkfGimFKmf1tCf |
| `styles-d-e.html` | D Bright Market and E Deep Harbour, the whole journey: find, approve, done, library | https://claude.ai/artifact/HaWr7SUbc72cNf4jcqVKyU |
| `styles-d-e-motion.html` | D and E with real motion, following the motion research rules | https://claude.ai/artifact/EU2AWK9H4QkT551jMCqGZG |

The review that led to them is in `docs/design/ux-review-2026-10-29/` (scorecard, problems, proposals, plan, style spec).
Rules every option keeps: "You pay nothing until you approve at the payment step", the Sandbox label from stored data,
D-051 wording, no ratings, no fake urgency. The live app allows only system fonts and no inline styles (CSP).
The owners chose to keep all five options for now. The screens work (spec `docs/specs/web-ux-phase1a.md` on branch
`feat/web-ux-phase1a`) starts only after the owners pick a direction.

## Round 2 (30 Oct 2026): options F, G, H

Built after a survey of open source UI sources (`round2/survey.md`, licences read from each repository's licence file where
marked verified). Previews are single self-contained HTML files in `round2/`. Preview only; not tested against the app's real
CSP, only in Chromium. Published copies:

- F Morning Edition (editorial print, the Stamp): https://claude.ai/artifact/BTNbUhkKn3idGnvd5A5c9W
- G Departure Board (high-contrast technical, the Flap Board): https://claude.ai/artifact/L2Bs4Qc7pxwtpM36qdpb1v
- H Swiss Ledger (Swiss grid, kinetic type, the Split): https://claude.ai/artifact/G9X556FduBiGEBPVsh1zYZ

Worker ranking: H, then G, then F. Suggested combinations: H with D, G with E, and take F's Stamp idea into either.
No screens work starts until the owners choose a direction.
