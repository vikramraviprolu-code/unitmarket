// BU-5 unit tests: how many calls polling may spend (the allowance), and the call gap (PERF-9).
// Pure functions and an injected clock: no provider, no database, no timer.
import { describe, expect, it } from 'vitest';
import { moneyCalls, pollAllowance, rateLimited } from './budget';

const cfg = { poll_budget_share: 0.5, capture_reserve_calls: 30 };
const at = (remaining_today: number, max_calls_per_day = 300) => ({
  remaining_today,
  max_calls_per_day,
});

describe('pollAllowance', () => {
  it('allowance table for max 300, share 0.5, reserve 30, max_items 100', () => {
    const table: [number, number][] = [
      [300, 100], // 150 above the line, capped by max_items
      [160, 10],
      [151, 1],
      [150, 0],
      [30, 0],
      [0, 0],
    ];
    for (const [remaining, expected] of table) {
      expect(pollAllowance(at(remaining), cfg, 100), `remaining ${remaining}`).toBe(expected);
    }
  });

  it('a null budget (dry run) is unlimited: the allowance is max_items', () => {
    expect(pollAllowance(null, cfg, 100)).toBe(100);
    expect(pollAllowance(null, cfg, 7)).toBe(7);
  });

  it('the line is the larger of the capture reserve and what the share leaves untouched', () => {
    // share 0.9: the line is max(30, 0.1 * 300) = 30
    expect(pollAllowance(at(40), { ...cfg, poll_budget_share: 0.9 }, 100)).toBe(10);
    expect(pollAllowance(at(30), { ...cfg, poll_budget_share: 0.9 }, 100)).toBe(0);
    // share 0.1: the line is max(30, 0.9 * 300) = 270
    expect(pollAllowance(at(280), { ...cfg, poll_budget_share: 0.1 }, 100)).toBe(10);
    expect(pollAllowance(at(270), { ...cfg, poll_budget_share: 0.1 }, 100)).toBe(0);
    // a big reserve wins over a generous share (share 1 leaves nothing untouched)
    expect(pollAllowance(at(200), { poll_budget_share: 1, capture_reserve_calls: 180 }, 100)).toBe(
      20,
    );
    expect(pollAllowance(at(180), { poll_budget_share: 1, capture_reserve_calls: 180 }, 100)).toBe(
      0,
    );
  });

  it('the boundary is exclusive: at the line it is 0, one above it is 1', () => {
    expect(pollAllowance(at(150), cfg, 100)).toBe(0);
    expect(pollAllowance(at(151), cfg, 100)).toBe(1);
  });

  it('is capped by max_items and never negative or fractional', () => {
    expect(pollAllowance(at(300), cfg, 5)).toBe(5);
    expect(pollAllowance(at(155.7), cfg, 100)).toBe(5); // floor of 5.7
    expect(pollAllowance(at(-20), cfg, 100)).toBe(0);
  });

  it('documented defaults apply when the config leaves the fields out', () => {
    expect(pollAllowance(at(160), {}, 100)).toBe(10); // share 0.5, reserve 30
    expect(pollAllowance(at(150), {}, 100)).toBe(0);
    expect(pollAllowance(at(40), { poll_budget_share: 1 }, 100)).toBe(10); // line = reserve 30
    expect(pollAllowance(at(30), { poll_budget_share: 1 }, 100)).toBe(0);
  });

  it('treats NaN, infinite, negative or malformed readings as 0 (fail closed)', () => {
    expect(pollAllowance(at(Number.NaN), cfg, 100)).toBe(0);
    expect(pollAllowance(at(Number.POSITIVE_INFINITY), cfg, 100)).toBe(0);
    expect(pollAllowance(at(100, Number.NaN), cfg, 100)).toBe(0);
    expect(pollAllowance(at(300, Number.POSITIVE_INFINITY), cfg, 100)).toBe(0);
    expect(pollAllowance(at(300, -300), cfg, 100)).toBe(0);
    expect(pollAllowance(undefined as never, cfg, 100)).toBe(0);
    expect(pollAllowance({} as never, cfg, 100)).toBe(0);
    expect(
      pollAllowance({ remaining_today: '300', max_calls_per_day: 300 } as never, cfg, 100),
    ).toBe(0);
  });

  it('a bad max_items gives 0', () => {
    expect(pollAllowance(null, cfg, 0)).toBe(0);
    expect(pollAllowance(null, cfg, -1)).toBe(0);
    expect(pollAllowance(null, cfg, Number.NaN)).toBe(0);
    expect(pollAllowance(at(300), cfg, 2.5)).toBe(0);
  });
});

describe('rateLimited (PERF-9: at most 2 calls a second)', () => {
  function rig(gap_ms: number) {
    let t = 1_000_000;
    const slept: number[] = [];
    const seen: { op: string; at: number }[] = [];
    const port = {
      environment: 'sandbox' as const,
      tag: 'port',
      getOrder(id: string): Promise<string> {
        seen.push({ op: `getOrder:${id}`, at: t });
        return Promise.resolve(`${this.tag}:${id}`);
      },
      getCapture(id: string): Promise<string> {
        seen.push({ op: `getCapture:${id}`, at: t });
        return Promise.resolve(id);
      },
    };
    const limited = rateLimited(port, {
      gap_ms,
      now: () => t,
      sleep: (ms: number) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    return { limited, slept, seen, tick: (ms: number) => (t += ms) };
  }

  it('the first call goes at once; the next waits the rest of the gap', async () => {
    const r = rig(500);
    await r.limited.getOrder('a');
    expect(r.slept).toEqual([]);
    await r.limited.getOrder('b');
    expect(r.slept).toEqual([500]);
    expect(r.seen.map((s) => s.at)).toEqual([1_000_000, 1_000_500]);
  });

  it('a call after a long pause does not wait', async () => {
    const r = rig(500);
    await r.limited.getOrder('a');
    r.tick(10_000);
    await r.limited.getCapture('c');
    expect(r.slept).toEqual([]);
  });

  it('time that has passed counts towards the gap', async () => {
    const r = rig(500);
    await r.limited.getOrder('a');
    r.tick(200);
    await r.limited.getOrder('b');
    expect(r.slept).toEqual([300]);
  });

  it('concurrent callers take separate slots, one gap apart', () => {
    // a sleeper that records the wait and does not move time: every caller sees the same "now"
    const waits: number[] = [];
    const l = rateLimited(
      { ping: () => Promise.resolve(1) },
      {
        gap_ms: 500,
        now: () => 7_000,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );
    return Promise.all([l.ping(), l.ping(), l.ping(), l.ping()]).then(() => {
      expect(waits).toEqual([500, 1000, 1500]);
    });
  });

  it('methods keep their this, return their value, and plain properties pass through', async () => {
    const r = rig(500);
    expect(r.limited.environment).toBe('sandbox');
    await expect(r.limited.getOrder('z')).resolves.toBe('port:z');
  });

  it('a gap of 0 never waits', async () => {
    const r = rig(0);
    await r.limited.getOrder('a');
    await r.limited.getOrder('b');
    expect(r.slept).toEqual([]);
  });

  it('a rejected call still uses its slot and passes the error on', async () => {
    let t = 0;
    const slept: number[] = [];
    const bad = {
      boom(): Promise<void> {
        return Promise.reject(new Error('down'));
      },
    };
    const l = rateLimited(bad, {
      gap_ms: 500,
      now: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    await expect(l.boom()).rejects.toThrow('down');
    await expect(l.boom()).rejects.toThrow('down');
    expect(slept).toEqual([500]);
  });
});

describe('moneyCalls (a money_only pass is bounded by the calls left, never by the reserve line)', () => {
  it('is the whole remaining count', () => {
    expect(moneyCalls({ remaining_today: 100, max_calls_per_day: 300 })).toBe(100);
    expect(moneyCalls({ remaining_today: 150, max_calls_per_day: 300 })).toBe(150);
    expect(moneyCalls({ remaining_today: 29, max_calls_per_day: 300 })).toBe(29);
    expect(moneyCalls({ remaining_today: 0, max_calls_per_day: 300 })).toBe(0);
    expect(moneyCalls({ remaining_today: 12.9, max_calls_per_day: 300 })).toBe(12);
  });
  it('is 0 for a reading that is not a sane number (fail closed)', () => {
    expect(moneyCalls({ remaining_today: Number.NaN, max_calls_per_day: 300 })).toBe(0);
    expect(moneyCalls({ remaining_today: -5, max_calls_per_day: 300 })).toBe(0);
    expect(moneyCalls({ remaining_today: Number.POSITIVE_INFINITY, max_calls_per_day: 300 })).toBe(
      0,
    );
    expect(moneyCalls(undefined as never)).toBe(0);
    expect(moneyCalls({} as never)).toBe(0);
    expect(moneyCalls({ remaining_today: '9', max_calls_per_day: 300 } as never)).toBe(0);
  });
});

describe('rateLimited with a call quota (the allowance counts CALLS)', () => {
  function rig(left: number) {
    const quota = { left };
    const ran: string[] = [];
    let t = 0;
    const slept: number[] = [];
    const port = {
      environment: 'sandbox' as const,
      getOrder: (id: string) => {
        ran.push(`get:${id}`);
        return Promise.resolve({ kind: 'order', id });
      },
      captureOrder: (id: string) => {
        ran.push(`capture:${id}`);
        return Promise.resolve({ kind: 'captured', id });
      },
    };
    const limited = rateLimited(port, {
      gap_ms: 500,
      now: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      quota,
    });
    return { limited, quota, ran, slept };
  }

  it('lets exactly quota.left calls through, then answers blocked by budget without calling', async () => {
    const r = rig(2);
    expect(await r.limited.getOrder('a')).toEqual({ kind: 'order', id: 'a' });
    expect(await r.limited.captureOrder('b')).toEqual({ kind: 'captured', id: 'b' });
    expect(r.quota.left).toBe(0);
    expect(await r.limited.getOrder('c')).toEqual({ kind: 'blocked', by: 'budget' });
    expect(await r.limited.captureOrder('d')).toEqual({ kind: 'blocked', by: 'budget' });
    expect(r.ran).toEqual(['get:a', 'capture:b']);
    expect(r.quota.left).toBe(0); // never negative
  });

  it('a blocked call takes no gap slot and does not sleep', async () => {
    const r = rig(1);
    await r.limited.getOrder('a');
    await r.limited.getOrder('b');
    await r.limited.getOrder('c');
    expect(r.slept).toEqual([]);
  });

  it('a quota of 0 (or less, or NaN) blocks everything', async () => {
    for (const left of [0, -3, Number.NaN]) {
      const r = rig(left);
      expect(await r.limited.getOrder('a')).toEqual({ kind: 'blocked', by: 'budget' });
      expect(r.ran).toEqual([]);
    }
  });

  it('concurrent callers share the quota: no more than quota.left calls run', async () => {
    const r = rig(3);
    const out = await Promise.all([1, 2, 3, 4, 5].map((i) => r.limited.getOrder(String(i))));
    expect(r.ran).toHaveLength(3);
    expect(out.filter((x) => x.kind === 'blocked')).toHaveLength(2);
  });

  it('a quota that is refilled between passes counts again', async () => {
    const r = rig(1);
    await r.limited.getOrder('a');
    expect(await r.limited.getOrder('b')).toEqual({ kind: 'blocked', by: 'budget' });
    r.quota.left = 2;
    await r.limited.getOrder('c');
    await r.limited.getOrder('d');
    expect(r.ran).toEqual(['get:a', 'get:c', 'get:d']);
  });

  it('plain properties pass through and cost nothing', () => {
    const r = rig(1);
    expect(r.limited.environment).toBe('sandbox');
    expect(r.quota.left).toBe(1);
  });
});
