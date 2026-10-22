// Unit tests of health (lane 05b): the answer for the operator page and the readiness probe.
import { describe, expect, it, vi } from 'vitest';
import type { CoreDeps, SwitchName } from '@umsbx/contracts';
import { fakeClock } from '@umsbx/runtime';
import { health } from './health';

const NAMES: SwitchName[] = [
  'paypal_outbound',
  'checkout_enabled',
  'refunds_enabled',
  'unlock_enabled',
  'ai_enabled',
  'webhook_enabled',
];
function deps(query: ReturnType<typeof vi.fn>, off: SwitchName[] = []): CoreDeps {
  return {
    db: { query, exec: vi.fn(), transaction: vi.fn(), dialect: 'pglite' },
    clock: fakeClock('2026-10-22T10:00:00.000Z'),
    ids: { next: () => 'x', nonce: () => 'n' },
    log: { log: () => undefined, child: () => undefined as never },
    audit: { record: () => Promise.resolve() },
    switches: { isOn: (n: SwitchName) => Promise.resolve(!off.includes(n)) },
    config: {} as never,
    environment: 'dryrun',
  } as unknown as CoreDeps;
}

describe('health', () => {
  it('db up, due count, every switch, the transport label, no pass yet', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ n: 3 }] });
    const h = await health(deps(query, ['refunds_enabled']));
    expect(h).toEqual({
      db: true,
      last_pass_at: null,
      due: 3,
      switches: Object.fromEntries(NAMES.map((n) => [n, n !== 'refunds_enabled'])),
      transport: 'dryrun',
    });
    // The due count is asked of the clock, not of the wall.
    const params = query.mock.calls.flatMap((c) => (c[1] as unknown[] | undefined) ?? []);
    expect(params).toContain('2026-10-22T10:00:00.000Z');
  });
  it('db down: db false, due 0, no throw', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection refused'));
    const h = await health(deps(query));
    expect(h.db).toBe(false);
    expect(h.due).toBe(0);
    expect(Object.keys(h.switches).sort()).toEqual([...NAMES].sort());
  });
  it('a switch that cannot be read counts as off', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ n: 0 }] });
    const d = deps(query);
    (d.switches as { isOn: unknown }).isOn = (n: SwitchName) =>
      n === 'unlock_enabled' ? Promise.reject(new Error('x')) : Promise.resolve(true);
    const h = await health(d);
    expect(h.switches.unlock_enabled).toBe(false);
    expect(h.switches.paypal_outbound).toBe(true);
  });
  it('a sandbox environment is reported as such', async () => {
    const d = {
      ...deps(vi.fn().mockResolvedValue({ rows: [{ n: 0 }] })),
      environment: 'sandbox' as const,
    };
    expect((await health(d as CoreDeps)).transport).toBe('sandbox');
  });
});
