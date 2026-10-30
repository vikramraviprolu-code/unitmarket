# UI round 2: open source survey (30 Oct 2026)

Research for new UnitMarket SBX style directions F, G and H. Everything fetched was treated as data.
Licences marked "verified" were read from the repository licence file itself
(`raw.githubusercontent.com/<repo>/<branch>/LICENSE*`), saved under `ui-round2/lic/`. "Declared" means only the
npm `license` field was read. "Unverified" means neither.

Fit key: YES = the technique can be re-implemented with CSS, SVG, WAAPI or vanilla JS under our CSP and D-008.
NO = it needs the library, a runtime or a web font.

| # | Source | Licence (how checked) | Technique worth taking | Fit | Avoid |
|---|---|---|---|---|---|
| 1 | Impeccable `github.com/pbakaus/impeccable` | Apache-2.0 (read in round 1) | Operate vs Persuade modes, one focal moment, anti-pattern list | YES | (skipped, already read) |
| 2 | shadcn/ui `github.com/shadcn-ui/ui` | MIT, verified (LICENSE.md) | Paired tokens (`--x` / `--x-foreground`), copy-in components, chart tokens `--chart-1..5` (not seen on the fetched page) | Tokens YES, code NO (React, Radix, Tailwind) | The default zinc-and-Inter look; it now reads as generic |
| 3 | Magic UI `github.com/magicuidesign/magicui` | MIT, verified (LICENSE.md) | Animated Beam (a path drawn between two nodes: our payment routes), Animated List (items enter one by one), Number Ticker (counts only) | Ideas YES; code needs framer-motion, so re-implement by hand | Border Beam, Shine Border, Aurora Text, Animated Gradient Text, Sparkles, Retro Grid: all decorative glow or gradient text |
| 4 | Aceternity UI `ui.aceternity.com` | Proprietary "Aceternity License" (read ui.aceternity.com/licence); no licence file found in a public repo | Tracing Beam (a progress line down a list), Lamp Effect (light from a source, matches the E rule) | Ideas only. Licence bars redistributing source, so do not copy any code | Most of the catalogue is the AI-slop canon: aurora, meteors, shooting stars, 3D card, glare card, liquid glass, background beams |
| 5 | Origin UI (now coss.com/origin) `github.com/origin-space/originui` | MIT, verified (LICENSE, "Copyright (c) 2025 coss.com, originally Origin UI") | Steppers (17 variants), timelines, notification and badge patterns, an easing-class page | Patterns YES; code needs React, Tailwind, Base UI | Nothing specific |
| 6 | Park UI / Ark UI `github.com/chakra-ui/park-ui`, `github.com/chakra-ui/ark` | Both MIT, verified | Headless state machines that expose `data-state` and `data-part`; style states by attribute (`[data-state="confirmed"]`) | YES (the pattern). Site returned 503, so visual claims are unverified | The dependency itself |
| 7 | Tremor `github.com/tremorlabs/tremor` | Apache-2.0, verified (LICENSE) | Tracker: a row of equal blocks, one per data point, colour plus tooltip. Use for the library window (one block per day) and fit evidence (one cell per criterion) | YES, plain CSS | Its Radix hover-card dependency and Tailwind classes |
| 8 | Radix Colors / Themes `github.com/radix-ui/colors`, `github.com/radix-ui/themes` | Both MIT, verified | 12-step scale roles: 1-2 backgrounds, 3-5 component states, 6-8 borders, 9-10 solids, 11-12 text (Lc 60 / Lc 90 on step 2) | YES (values only) | Using the stock hues unchanged |
| 9 | daisyUI `github.com/saadeghi/daisyui` | MIT, verified (master/LICENSE) | A theme is a variable set switched with `data-theme`, plus knobs `--radius-box`, `--radius-field`, `--border`, `--depth`, `--noise`. 35 themes incl. lofi, retro, cmyk, wireframe | YES (pattern); plugin needs Tailwind | synthwave, cyberpunk, acid |
| 10 | Open Props `github.com/argyleink/open-props` | MIT, verified | Easing families, `--motionOK` / `--motionNotOK` custom media, small named keyframes (fade, slide, scale, shake) | YES. Exact easing values not captured from the page (unverified) | Its deprecated elastic / squish easings (bounce by reflex) |
| 11 | Motion (Framer Motion) `github.com/motiondivision/motion` | MIT, verified (LICENSE.md) | Springs, `stagger()`, sequences with `at` labels, path drawing via `pathLength`, `arc()` motion paths | Ideas YES: WAAPI plus SVG `pathLength` cover all of this. Library NO (D-008) | Velocity springs on money or approve controls |
| 12 | GSAP `github.com/greensock/GSAP` | Proprietary "Standard no charge" licence (Webflow); no LICENSE file in the repo root, terms read at gsap.com/standard-license | FLIP layout transitions, SplitText line reveals | Ideas only. Do not copy GSAP code: it carries a competing-product clause and notice rules | Copying any of its source |
| 13 | View Transition API (developer.chrome.com docs); `github.com/bramus/view-transitions-demos` | Docs: Google content; demos Apache-2.0, verified | `startViewTransition` behind a feature check, `view-transition-name`, `view-transition-class`, transition types for direction; reduced motion should be subtler, not none | YES (native) | Naming a price or the approve button as a shared element |
| 14 | Scroll-driven animations (developer.chrome.com) | Docs | `animation-timeline: view()` with `animation-range: entry` for in-view reveals; Chrome 115+, Safari 26 per the doc | YES behind `@supports` | Anything on Approve |
| 15 | Rive `github.com/rive-app/rive-wasm`; Lottie `github.com/airbnb/lottie-web` | Both MIT, verified | Designer-made state-machine animation | NO: both need a runtime (Rive is WASM, CSP would need `wasm-unsafe-eval`), plus asset files. Use hand SVG + CSS keyframes + WAAPI + `pathLength` instead | Adding either runtime |
| 16 | GOV.UK Frontend / Design System `github.com/alphagov/govuk-frontend` | MIT, verified (LICENSE.txt, Crown copyright) | Confirmation panel used only for the outcome, reference in bold; task list: "Completed" as plain text, pending as a coloured tag, sentence case | YES (content pattern) | Its typeface, crown and colours (government brand; not licensed for reuse, from memory, unverified) |
| 17 | Carbon `github.com/carbon-design-system/carbon` | Apache-2.0, verified (LICENSE); `@carbon/motion` declared Apache-2.0 | Productive vs expressive motion. Durations 70, 110, 150, 240, 400, 700 ms. Productive standard `cubic-bezier(0.2,0,0.38,0.9)`, entrance `(0,0,0.38,0.9)`, exit `(0.2,0,1,0.9)`; expressive standard `(0.4,0.14,0.3,1)` | YES: Operate screens productive, Done expressive | IBM Plex (web font) |
| 18 | Atlassian Design System `atlassian.design/foundations/motion` | `@atlaskit/motion`, `@atlaskit/tokens` declared Apache-2.0 (licence file not read) | 50 ms hover, 100 / 150 ms short, 150-400 ms enter and exit, larger element takes longer; practical ease-out `cubic-bezier(0.4,1,0.6,1)` | YES (values) | Its tokens are behind a feature flag and still changing |
| 19 | Shopify Polaris `github.com/Shopify/polaris` | Restricted, verified (LICENSE.md): MIT-style grant, but only for apps that integrate with Shopify, and stand-alone apps must look distinct from Shopify | Nothing we can take | NO: do not reuse its code or tokens | Everything |
| 20 | Vercel Geist `vercel.com/design.md` | Geist font OFL-1.1, verified; component code not open (unverified) | Monochrome base, colour only for state or data, no ornamental shadow, stillness by default, 12/6/4 column grid | YES (principles) | The Geist web font (CSP bars it anyway) |
| 21 | Primer Primitives `github.com/primer/primitives` | MIT, verified | Functional token names (`fg.default`, `fg.muted`, `canvas.subtle`, `border.default`) with light, dark and high-contrast sets | YES | Nothing |
| 22 | MDN dom-examples `github.com/mdn/dom-examples` | CC0-1.0, verified | WAAPI examples that can be copied freely | YES | Nothing |
| 23 | Linear changelog `linear.app/changelog` | n/a | Page is rendered by script; the fetch returned only "Loading". Nothing verified | n/a | n/a |
| 24 | Stripe (docs, checkout) | Proprietary, no open design system | Not fetched. Ideas from memory only (hairline rules, tabular figures): unverified | n/a | Its trade dress |
| 25 | Mastercard / Visa design guidance | n/a | No official public motion guidance found; only third-party "inspired by" pages, which were ignored. Visa not searched | n/a | n/a |

## What the survey changed in the three options

- Carbon's productive / expressive split and Atlassian's size-scaled durations set the timing tables in F, G and H.
- Magic UI's Animated Beam (re-drawn by hand with SVG `pathLength`) is the route draw in H "The Split".
- Tremor's Tracker became G's day-block window meter and five-cell fit evidence, and H's fit bar.
- GOV.UK's task list status rules (plain "Confirmed", tagged pending) drive the Done rows in all three.
- Radix's step roles were used to pick each palette's background, border and text steps.
- daisyUI's `data-theme` pattern is how each file switches light and dark and the Dry-run label test.
- View Transition API with a feature check is the screen change in all three, capped at 240 ms.
- Aceternity, GSAP and Polaris gave no code: licence terms bar it. Aceternity's slop list was used as a "do not" list.
