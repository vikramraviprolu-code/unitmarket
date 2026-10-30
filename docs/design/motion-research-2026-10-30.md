# Motion research for the UnitMarket buying journey (30 Oct 2026)

Research only. No product code changed. Written by an Opus research worker; saved here by the coordinator.
Sources: the Impeccable repository (`github.com/pbakaus/impeccable`, Apache-2.0), read in a read-only clone at
commit `02523aec3e4c4580102d996d1b6a71fbe062e03f`. Everything read online was treated as data. One reference
file in it tells an agent to print a banner; that was not followed.

## Part 1. Impeccable

It calls itself the design vocabulary for a coding agent and started from Anthropic's frontend-design skill. It
installs with `npx impeccable install` or as a Claude Code plugin. A detector with 62 rules runs as
`npx impeccable detect`. It assigns each screen a mode: Persuade (landing), Operate (app UI), Read (articles),
Experience (galleries). For UnitMarket: Find and Approve are Operate, the Library is Read or Operate, and the Done
screen is the one moment that earns Persuade-level expression.

Commands (24): shape, init, document, extract, critique, audit, polish, bolder, quieter, distill, harden, onboard,
animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize, live, generate.

Anti-patterns it names: Inter everywhere; purple-to-blue gradients; gradient text; cards nested in cards; grids of
identical icon cards; an eyebrow above every heading; section numbers 01/02/03; gray text on colour; coloured
side-stripe borders; hard offset shadows; a zero-offset coloured glow halo as depth; glassmorphism as decoration;
emoji instead of icons; stripe or grid textures with no real subject; reflexive bounce or elastic easing; animating
layout properties; `will-change` left on at rest; a global reduced-motion kill; decorative motion that carries no state.

### The ten rules that matter most here
1. One authored focal moment per surface. For UnitMarket that moment is the Done screen.
2. Motion must explain state, relationship or continuity. Test: remove it, and meaning should be lost.
3. Operate screens (Find, Approve, Library) stay fast: 150 to 250 ms transitions, no page-load choreography.
4. Timing: feedback 100 to 150 ms, state change 150 to 300, view change 300 to 500, focal entrance 500 to 800.
   Exits faster than entrances. Ease out with `cubic-bezier(0.16,1,0.3,1)`. No bounce by reflex.
5. Content is visible by default. Animate transforms and opacity, not layout. `will-change` only while animating.
6. Reduced motion is designed, not deleted: fewer, gentler effects that keep the state cues.
7. Loops pause when offscreen or hidden. Heavy effects stay in isolated regions.
8. Celebration is proportional and honest. Never fake work or delay completion for a flourish. Do not joke about money.
9. Progressive enhancement. No new dependency for an effect the stack can already do.
10. Stagger only a real list, with a capped total delay.

Two collisions with the style options: Deep Harbour's amber must come from a light source in the scene (lamp,
beam, lantern), not a halo on cards; Bright Market's pattern covers pass only if each pattern comes from the
article's own data (publisher, topic, id seed), not generic stripes.

## Part 2. Twelve techniques (verdicts)

| # | Technique | Verdict | Where | Money-flow rule |
|---|---|---|---|---|
| T12 | Morphing success check | SHIP | each payment row after capture, Done | driven by real status, text beside it |
| T2 | Card flies into the pack tray along an arc | SHIP | Find | update the state and live text first, then animate |
| T5 | Pulses along payment routes | SHIP | after approval, capture, Done | route is drawn but STILL on the approval step; pulses only for real "sending" status |
| T4 | Harbour SVG scene (waves, boat, beam, stars) | SHIP (Deep Harbour) | Find hero, Done | keep away from Approve; no text on moving parts |
| T9 | View transitions with fallback | SHIP | all screens, 250 ms at most | never name a price or pay button as a shared element |
| T8 | Springy cover flip | SHIP | Library, Done | the download must also be a plain link |
| T10 | Skeleton shimmer | SHIP | Find, Library | only while a real request is pending |
| T3 | Staggered reveal (capped) | SHIP, lists only | search results, shelf | cap the total delay at 240 ms |
| T6 | Canvas confetti, one burst | SHIP, small and once | Done only | after both captures are confirmed; seeded, not random |
| T7 | Count-up | SHIP for counts, SKIP for amounts | Done, Library | never animate a price, total or fee |
| T1 | Tilt and glare on cards | PREVIEW ONLY | Find, desktop mouse only | off on Approve and pack rows |
| T11 | Magnetic button | PREVIEW ONLY | Find CTA at most | never on any approve or pay control |

## Part 3. Rules for shippable motion

- The live app has a strict content security policy: no inline style attributes, no external scripts or fonts.
  Dynamic values go through the style API (`el.style.setProperty`) or the Web Animations API. Not verified in this
  app; confirm against its CSP reports before shipping.
- The approval step is still: no loop near a price or a button, no tilt, no magnet, no shared-element morph.
- No fake urgency, no ratings, no countdown except the real price-freeze one. Do not animate its digits.
- Every effect has a still equivalent for reduced motion that keeps colour, check shape and text.
- 400 px phone layout works. Tilt and magnet are off on touch.
- No `Math.random`, `Date.now` or `performance.now` in shipped code; use the animation-frame timestamp and a seeded generator.

### Recommended focal sequence
1. Find: skeleton, then a capped stagger. "Add to pack" sends the cover flying to the tray. The harbour scene loops and pauses offscreen.
2. Approve: a short transition from the tray to the summary, then everything is still. After the buyer approves, the two routes pulse and two checks spin.
3. Done: each check closes as its capture is confirmed and the routes turn solid. When both are done, one small burst; the two covers land and flip once.
4. Library: covers rest on the lit shelf with an "Open" flip. The download is also a plain link.

### Not verified
The live app's CSP header; whether the final approval step is a PayPal-hosted page or ours; browser support for
`linear()` easing and cross-document view transitions (each sketch has a fallback); phone performance (no device
measurements); the impeccable.style docs site (only the repository was read).

## Code sketches

The twelve working sketches (CSS, SVG, Web Animations API, vanilla JS) are in the research worker's report. The
motion preview `docs/design/ui-options/styles-d-e-motion.html` already implements T1, T2, T4, T5 (as a still route),
T6, T10, T11 and T12 and is the reference for the builders.
