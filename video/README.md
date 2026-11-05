# UnitMarket demo video (HyperFrames)

A 2:56 judges' video for the PayPal AI Hackathon, written as code. Every frame is HTML and CSS, animated with GSAP, and rendered to MP4 by [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0). The voice-over is generated on this machine with HyperFrames' local text-to-speech (Kokoro-82M); nothing is sent to a cloud service.

This folder is tooling, not product. It sits outside the pnpm workspace, adds no dependency to any package, and is never imported. The rendered MP4 is not committed; it is attached to the pull request thread instead.

## Why HyperFrames

| Option      | Fit for this video                                                                                          | Verdict    |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| HyperFrames | Our cards are already HTML; screen recordings drop in as `<video>`; renders headless; Apache-2.0            | Chosen     |
| Remotion    | Same idea in React, but needs a rewrite of the cards, and its licence is free only for teams of up to three | Not chosen |
| Blender     | A 3D suite; strong for 3D scenes, weak for UI screens, text and charts                                      | Not chosen |

## What is in the video

| #   | Scene                                                         | Source                                                             | Label on screen            |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| 1   | The problem: 49¢ fee on a 7.6¢ purchase                       | animated card                                                      | Simulation                 |
| 2   | Title                                                         | animated card                                                      | none                       |
| 3   | A reader buys two articles from two publishers                | screen recording of this app, offline                              | Dry run                    |
| 4   | An AI agent with a $5.00 and 3-purchase cap; the cap stops it | real answers from this app's `/api/v1` and MCP routes, keys hidden | Dry run                    |
| 5   | 10,000 agent trades                                           | screen recording of the simulation app                             | Simulation                 |
| 6   | Three ways to pay: $4,926.47, $83.40, $20.90                  | animated chart, one linear scale                                   | Simulation, Proposal       |
| 7   | Consolidation pools filling                                   | screen recording of the simulation app                             | Simulation                 |
| 8   | Pooling results: 10,000 payments to 233; 33 of 33 bundles     | animated card                                                      | Simulation                 |
| 9   | What we built: 335k lines, 14,480 tests, 81 PRs               | animated card                                                      | none                       |
| 10  | Four roles, ten personas, forty domains                       | animated card                                                      | Simulation                 |
| 11  | Architecture                                                  | animated card                                                      | Built, Simulated, Proposal |
| 12  | Real, dry run, simulated and proposed                         | animated card                                                      | all four                   |
| 13  | The three pillars                                             | animated card                                                      | Vision                     |
| 14  | Close                                                         | animated card                                                      | none                       |

The recordings in this cut are dry run. The plan (D1) is to replace scene 3 with an owner-run recording on the PayPal sandbox; the scene is sized for that swap. Scene 12 says which parts were run on the sandbox (the owner's sitting on 29 October 2026, see `docs/evidence/`).

## Files

| Path                             | What it is                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `script.json`                    | The voice-over, one entry per beat, with the scene it belongs to                                           |
| `src/scenes.html`                | The scene markup (copy from the video cards)                                                               |
| `src/cards.css`, `src/video.css` | Styles: the cards' design tokens and the video-only additions                                              |
| `src/anim.js`                    | Every animation, on one GSAP timeline, timed from the voice-over                                           |
| `build.mjs`                      | Lays the scenes out from the voice-over lengths and writes `index.html`, `captions.srt` and `captions.vtt` |
| `voice.mjs`                      | Generates `assets/vo/*.m4a` and `assets/vo/durations.json`                                                 |
| `index.html`                     | The generated HyperFrames composition (do not edit by hand)                                                |
| `assets/footage/`                | The three screen recordings, 1080p                                                                         |
| `assets/agent-story.json`        | The recorded agent API answers shown in scene 4                                                            |
| `capture/`                       | Playwright scripts that recorded the footage and the agent answers                                         |
| `vendor/gsap.min.js`             | GSAP 3.14.2, vendored so renders need no network. Not Apache-2.0: see `vendor/NOTICE`                      |

## Render it

Needs Node 22, ffmpeg, and Chromium (HyperFrames finds a local one).

```sh
cd video
node build.mjs                                   # writes index.html and the captions
npx --yes hyperframes@0.8.185 lint               # 0 errors expected
npx --yes hyperframes@0.8.185 render -o unitmarket-demo.mp4 -q standard -f 30
```

Change the words: edit `script.json`, then `HYPERFRAMES_PYTHON=<python with kokoro-onnx and soundfile> node voice.mjs b05` (one beat) or `node voice.mjs` (all), then `node build.mjs`. Scene lengths follow the voice.

Upload `captions.srt` to YouTube as the English subtitles.

## Re-record the footage

All offline. Start the app with `UMS_MODE=offline` and the synthetic e2e fixture values from `apps/web/playwright.config.ts` on port 3200, and the simulation app (`pnpm sim:app --size small --seed 20261021`) on port 3100. Then:

```sh
node video/capture/sbx-journey.js        # reader journey (dry run)
node video/capture/agent-story.js        # agent cap story, writes assets/agent-story.json
node video/capture/sim-market.js         # simulation market and pools
```

Never record the sign-up or password-reset pages: they show a real email address.

## Honesty rules this video follows

- Every scene carries its label: PayPal sandbox, Dry run, Simulation or Proposal.
- No third-party logos or music. "Uber model" is said as "a ride-hailing model".
- Fees are computed from PayPal's public US pricing pages (October 2026), used as inputs, not quotes.
- The micro-settlement price and pooled settlement are our proposal to PayPal. The video makes no claim about what PayPal does or does not offer today; PayPal publishes a micropayments rate, which the simulation uses only as an input.
