// Animation for the whole video on one root timeline. T comes from build.mjs:
// T.s[scene] = { start, dur }, T.vo[beat] = { start, dur }, all in seconds from the video start.
/* global gsap, T */
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
const S = (id) => T.s[id].start;
const at = (beat, frac = 0) => T.vo[beat].start + frac * T.vo[beat].dur;
const ease = 'power3.out';

// Every scene fades in quickly (opacity is allowed on a clip).
for (const id of Object.keys(T.s)) {
  tl.fromTo('#s-' + id, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'none' }, S(id));
}
for (const v of ['#v-journey', '#v-market', '#v-pools']) {
  const scene = { '#v-journey': 'journey', '#v-market': 'market', '#v-pools': 'poolsrec' }[v];
  tl.fromTo(v, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'none' }, S(scene) + 0.1);
}
const rise = (sel, t, opts = {}) =>
  tl.fromTo(
    sel,
    { opacity: 0, y: 28 },
    { opacity: 1, y: 0, duration: 0.6, ease, stagger: opts.stagger || 0 },
    t,
  );
const grow = (sel, t, d = 1.1) =>
  tl.fromTo(
    sel,
    { scaleX: 0, transformOrigin: 'left center' },
    { scaleX: 1, duration: d, ease: 'power2.out' },
    t,
  );
const count = (sel, from, to, t, d, fmt) => {
  const o = { v: from };
  const el = () => document.querySelector(sel);
  tl.fromTo(
    o,
    { v: from },
    {
      v: to,
      duration: d,
      ease: 'power2.out',
      onUpdate: () => {
        const e = el();
        if (e) e.firstChild.nodeValue = fmt(o.v);
      },
    },
    t,
  );
};
const usd = (v) =>
  '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lift = (sel, t) =>
  tl.fromTo(
    sel,
    { boxShadow: '0 0 0 0 rgba(31,71,229,0)' },
    { boxShadow: '0 0 0 6px rgba(31,71,229,.9)', duration: 0.35, ease },
    t,
  );
const drop = (sel, t) =>
  tl.to(sel, { boxShadow: '0 0 0 0 rgba(31,71,229,0)', duration: 0.35, ease }, t);

// 1. Problem: start close on the agent panel, pull out to the reader.
tl.fromTo('#problem-cam', { scale: 1.35 }, { scale: 1.35, duration: 0.01 }, S('problem'));
tl.fromTo(
  '#problem-cam > .kicker, #problem-cam > h2, #problem-cam > .brandmark, #problem-cam > .foot, #problem-reader',
  { opacity: 0 },
  { opacity: 0, duration: 0.01 },
  S('problem'),
);
tl.to(
  '#problem-cam > .kicker, #problem-cam > h2, #problem-cam > .brandmark, #problem-cam > .foot, #problem-reader',
  { opacity: 1, duration: 0.8, ease: 'none' },
  at('b02') - 0.3,
);
count('#problem-fee', 0, 49, at('b01', 0.55), 1.2, (v) => Math.round(v) + '¢');
tl.to('#problem-cam', { scale: 1, duration: 1.6, ease: 'power2.inOut' }, at('b02') - 0.4);
lift('#problem-reader', at('b02', 0.1));
drop('#problem-reader', T.s.problem.start + T.s.problem.dur - 0.5);

// 2. Title
tl.fromTo(
  '#title-k',
  { opacity: 0, y: 20 },
  { opacity: 1, y: 0, duration: 0.5, ease },
  S('title') + 0.1,
);
tl.fromTo(
  '#title-h',
  { opacity: 0, y: 40, filter: 'blur(10px)' },
  { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.8, ease },
  S('title') + 0.25,
);
tl.fromTo(
  '#title-s',
  { opacity: 0, y: 24 },
  { opacity: 1, y: 0, duration: 0.6, ease },
  at('b03', 0.25),
);
tl.fromTo('#title-f', { opacity: 0 }, { opacity: 1, duration: 0.6, ease }, at('b03', 0.6));

// 3. Journey: lower thirds slide in.
for (const id of ['#lt-approve', '#lt-sandbox']) {
  tl.fromTo(
    id,
    { opacity: 0, x: -40 },
    { opacity: 1, x: 0, duration: 0.5, ease },
    T.c[id.slice(1)].start,
  );
}

// 4. Agent: lines type in with the voice.
const lines = [
  ['#ag1', 0.12],
  ['#ag2', 0.2],
  ['#ag3', 0.36],
  ['#ag4', 0.4],
  ['#ag5', 0.46],
  ['#ag6', 0.55],
  ['#ag7', 0.66],
  ['#ag8', 0.69],
  ['#ag9', 0.73],
  ['#ag10', 0.76],
  ['#ag11', 0.8],
  ['#ag12', 0.83],
  ['#ag13', 0.9],
  ['#ag14', 0.94],
];
rise('#agent-term', S('agent') + 0.2);
for (const [sel, f] of lines) {
  const isCmd = document.querySelector(sel) && document.querySelector(sel).classList.contains('c');
  tl.fromTo(
    sel,
    { opacity: 0, clipPath: 'inset(0 100% 0 0)' },
    {
      opacity: 1,
      clipPath: 'inset(0 0% 0 0)',
      duration: isCmd ? 0.5 : 0.15,
      ease: isCmd ? 'steps(24)' : 'none',
    },
    at('b09', f),
  );
}
tl.fromTo(
  '#ag14',
  { scale: 1 },
  { scale: 1.06, duration: 0.25, yoyo: true, repeat: 1, transformOrigin: 'left center' },
  at('b09', 0.94) + 0.2,
);

// 6. Fees: bars grow in turn, values count up.
rise('#fees-r1, #fees-r2, #fees-r3', S('fees') + 0.2, { stagger: 0.12 });
tl.set('#fees-b1, #fees-b2, #fees-b3, #fees-v1, #fees-v2, #fees-v3', { opacity: 0 }, S('fees'));
tl.set('#fees-b1, #fees-v1', { opacity: 1 }, at('b11', 0.02));
grow('#fees-b1', at('b11', 0.02), 1.6);
count('#fees-v1', 0, 4926.47, at('b11', 0.02), 1.6, usd);
tl.set('#fees-b2, #fees-v2', { opacity: 1 }, at('b11', 0.3));
grow('#fees-b2', at('b11', 0.3), 0.6);
count('#fees-v2', 4926.47, 83.4, at('b11', 0.3), 1.4, usd);
rise('#fees-p1', at('b11', 0.58));
tl.set('#fees-b3, #fees-v3', { opacity: 1 }, at('b11', 0.75));
grow('#fees-b3', at('b11', 0.75), 0.6);
count('#fees-v3', 83.4, 20.9, at('b11', 0.75), 1.2, usd);
rise('#fees-p2', at('b11', 0.92));

// 8. Pools card
rise('#pools-a', S('pools') + 0.1);
grow('#pools-b1', S('pools') + 0.3, 0.9);
grow('#pools-b2', at('b13', 0.28), 0.5);
lift('#pools-a', at('b13', 0.28));
drop('#pools-a', at('b13', 0.45));
rise('#pools-b', at('b13', 0.12));
grow('#pools-b3', at('b13', 0.14), 0.9);
grow('#pools-b4', at('b13', 0.32), 0.5);
rise('#pools-t1', at('b13', 0.5));
lift('#pools-t1', at('b13', 0.68));
drop('#pools-t1', at('b13', 0.82));
rise('#pools-t2', at('b13', 0.8));

// 9. Built: stats stagger in with the voice.
rise('#built-grid .stat', S('built') + 0.2, { stagger: 0.55 });

// 10. Personas
rise('#personas-a .person', S('personas') + 0.1, { stagger: 0.12 });
rise('#personas-b .person', at('b15', 0.25), { stagger: 0.12 });
rise('#personas-t span', at('b15', 0.5), { stagger: 0.05 });

// 11. Architecture: left to right.
rise('#arch-row > *', S('arch') + 0.1, { stagger: 0.18 });

// 12. Truth table
rise('#truth-rows .tr', S('truth') + 0.1, { stagger: 0.9 });

// 13. Pillars, each lit as it is named.
rise('#pil-1, #pil-2, #pil-3', S('pillars') + 0.05, { stagger: 0.1 });
lift('#pil-1', at('b17', 0.0));
drop('#pil-1', at('b17', 0.13));
lift('#pil-2', at('b17', 0.13));
drop('#pil-2', at('b17', 0.27));
lift('#pil-3', at('b17', 0.27));
drop('#pil-3', at('b17', 0.45));
rise('#pil-band', at('b17', 0.45));

// 14. End
rise('#end-h', S('end') + 0.15);
rise('#end-ask > div', S('end') + 0.9, { stagger: 0.25 });

window.__timelines['main'] = tl;
