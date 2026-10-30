'use client';
import { useEffect, useRef } from 'react';

// T4 harbour scene (SKIN-B, docs/specs/skin-b-harbour-motion.md). Decorative, Deep Harbour only (the CSS
// hides it in Bright Market). It carries no text and no data: URI. The waves, boat, beam, lamp and stars are
// moved by CSS transforms in skin-harbour.css, inside a no-preference block, so reduced motion shows the
// still drawing. The loops pause while the scene is offscreen and while the tab is hidden.

// A seamless wave strip: eight periods of 220 units, so the strip is 1760 wide and slides by 880.
const wave = (y: number, lift: number): string =>
  `M0 ${y}${Array.from({ length: 8 }, () => ` q55 ${-lift} 110 0 t110 0`).join('')} V180 H0 Z`;

const STARS: ReadonlyArray<readonly [number, number, number, string]> = [
  [60, 30, 1.6, 'hs-tw'],
  [190, 62, 1.2, 'hs-tw hs-t2'],
  [310, 24, 1.8, 'hs-tw hs-t3'],
  [420, 74, 1.2, 'hs-tw'],
  [540, 36, 1.6, 'hs-tw hs-t2'],
  [650, 16, 1.2, 'hs-tw hs-t3'],
  [720, 70, 1.8, 'hs-tw'],
  [830, 26, 1.2, 'hs-tw hs-t2'],
  [250, 96, 1.2, 'hs-tw hs-t3'],
  [480, 108, 1.4, 'hs-tw'],
];

export function HarbourScene() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let onscreen = true;
    const apply = () => el.classList.toggle('is-paused', !onscreen || document.hidden);
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            for (const e of entries) onscreen = e.isIntersecting;
            apply();
          });
    io?.observe(el);
    document.addEventListener('visibilitychange', apply);
    apply();
    return () => {
      document.removeEventListener('visibilitychange', apply);
      io?.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className="harbour-scene" aria-hidden="true">
      <svg viewBox="0 0 880 180" preserveAspectRatio="xMidYMid slice" focusable="false">
        <defs>
          <linearGradient id="hs-beam" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0" className="hs-beam-stop" />
            <stop offset="1" className="hs-beam-stop hs-beam-end" />
          </linearGradient>
        </defs>
        <g className="hs-sky">
          {STARS.map(([x, y, r, c]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} className={c} />
          ))}
          <circle cx="130" cy="44" r="30" className="hs-moon-halo" />
          <circle cx="130" cy="44" r="15" className="hs-moon" />
        </g>
        <polygon className="hs-beam" points="770,52 160,6 160,98" fill="url(#hs-beam)" />
        <g className="hs-light">
          <polygon points="756,180 764,70 776,70 784,180" />
          <rect x="758" y="52" width="24" height="20" />
          <polygon points="756,52 770,36 784,52" />
          <rect x="762" y="57" width="16" height="10" className="hs-lamp" />
        </g>
        <g className="hs-wave hs-wave-back">
          <path d={wave(120, 14)} />
        </g>
        <g className="hs-boat">
          <path d="M458 108 L458 70 L430 108Z" className="hs-sail" />
          <path d="M464 100 L464 76 L490 108Z" className="hs-sail hs-sail-2" />
          <path d="M424 112 H496 L486 126 H434Z" className="hs-hull" />
        </g>
        <g className="hs-wave hs-wave-front">
          <path d={wave(138, 10)} />
        </g>
      </svg>
    </div>
  );
}
