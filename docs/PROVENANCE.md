# Provenance of copied and adapted files

Every file adapted from the simulation repository carries a header comment
`Adapted from AIC_Hackathon_UnitMarket/<path> at <sha>` (or `Origin: ...`). SBX owns the result.
Files that cannot hold comments (JSON) are listed here instead.

| File               | Origin (simulation repo, SHA a36ddc0) | Change                                                                           |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| eslint.config.mjs  | eslint.config.mjs                     | Rewritten for SBX layering (S1 to S6) and isolation; NO_REAL_TIME rule set kept. |
| vitest.config.ts   | vitest.config.ts                      | Six suites by file name kept; roots changed to SBX layout.                       |
| tsconfig.base.json | tsconfig.base.json                    | Same strict options; added `types: ["node"]`.                                    |
| .prettierrc.json   | .prettierrc                           | Unchanged.                                                                       |
| package.json       | package.json                          | New name and scripts; same pinned tool versions.                                 |
