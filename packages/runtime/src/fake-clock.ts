import type { Clock, IsoUtc } from './temp-contracts-f1';

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function parse(iso: IsoUtc): number {
  const t = ISO_Z.test(iso) ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) throw new Error(`fakeClock: not an ISO 8601 UTC time with Z: ${iso}`);
  return t;
}

// A clock that moves only when the test tells it to. now() returns a fresh Date each call.
export function fakeClock(
  startIso: IsoUtc,
): Clock & { advance(ms: number): void; set(iso: IsoUtc): void } {
  let t = parse(startIso);
  return {
    now: () => new Date(t),
    advance(ms: number) {
      if (!Number.isFinite(ms)) throw new Error('fakeClock.advance: ms must be a finite number');
      t += ms;
    },
    set(iso: IsoUtc) {
      t = parse(iso);
    },
  };
}
