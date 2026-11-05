// INT-CTL / CTL.7: the exposure screen. Each group's state, the last change and the toggle come from the
// api_exposure row, not from trace_events (F12). `changed_by` shows only on an MFA session; without it the
// screen says "an operator". The row equals the newest journal event of the group (R2-1: compared by sha256).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_GROUPS } from '@umsbx/contracts';
import { bootA, idemKey } from './api-v1/a-support';
import type { ARig, Handler, Sess } from './api-v1/a-support';
import { exposureView, EXPOSURE_LABELS } from './lib/exposure-view';

vi.mock('server-only', () => ({}));

let rig: ARig;
let off: { POST: Handler };
let on: { POST: Handler };
let op: Sess;
let noMfa: Sess;
const post = (h: Handler, s: Sess, g: string, reason_code = 'incident') =>
  rig.old(h, s, {
    method: 'POST',
    url: `/api/ops/api-exposure/${g}/x`,
    body: { reason_code },
    params: { group: g },
    idem: idemKey(),
  });

beforeAll(async () => {
  rig = await bootA();
  off = (await import('./app/api/ops/api-exposure/[group]/off/route')) as never;
  on = (await import('./app/api/ops/api-exposure/[group]/on/route')) as never;
  op = await rig.session({ kind: 'operator', operator_id: 'opr_view_mfa', mfa: true });
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_view_plain', mfa: false });
});
afterAll(async () => rig.app.close());

describe('exposureView (pure)', () => {
  const rows = (over: Record<string, unknown> = {}) =>
    API_GROUPS.map((g) => ({
      group_name: g,
      enabled: true,
      changed_by: null as string | null,
      changed_at: '1970-01-01T00:00:00.000Z',
      reason_code: null as string | null,
      ...(g === 'orders' ? over : {}),
    }));

  it('has a plain label for each of the 14 groups and shows seeded rows as never changed', () => {
    for (const g of API_GROUPS) expect(EXPOSURE_LABELS[g], g).toMatch(/\S/);
    const v = exposureView(rows(), { mfa: true });
    expect(v).toHaveLength(API_GROUPS.length);
    for (const line of v) {
      expect(line.state).toBe('on');
      expect(line.last_change).toBeNull();
      expect(line.toggle).toMatchObject({ action: 'off', needs_mfa: false });
    }
  });

  it('shows changed_by only with MFA; without it the screen says "an operator"', () => {
    const changed = rows({
      enabled: false,
      changed_by: 'operator:opr_secret_name',
      changed_at: '2026-11-05T10:00:00.000Z',
      reason_code: 'incident',
    });
    const withMfa = exposureView(changed, { mfa: true }).find((l) => l.group === 'orders')!;
    const without = exposureView(changed, { mfa: false }).find((l) => l.group === 'orders')!;
    expect(withMfa.state).toBe('off');
    expect(withMfa.last_change).toMatchObject({ by: 'operator:opr_secret_name', reason_code: 'incident' });
    expect(withMfa.toggle).toMatchObject({ action: 'on', needs_mfa: true });
    expect(without.last_change).toMatchObject({ by: 'an operator', reason_code: 'incident' });
    expect(JSON.stringify(without)).not.toContain('opr_secret_name');
  });
});

describe('the read behind the screen', () => {
  it('returns the 14 rows from api_exposure and never touches trace_events', async () => {
    const mod = await import('./composition/ops-agents');
    const seen: string[] = [];
    const q = rig.app.db.query.bind(rig.app.db);
    rig.app.db.query = (async (sql: string, p?: unknown[]) => {
      seen.push(sql);
      return q(sql, p);
    }) as never;
    try {
      const r = await mod.readExposure({ kind: 'operator', operator_id: 'opr_x', mfa: true });
      expect(r).not.toBeNull();
      expect(r!.map((x) => x.group_name).sort()).toEqual([...API_GROUPS].sort());
    } finally {
      rig.app.db.query = q as never;
    }
    expect(seen.some((s) => /trace_events/i.test(s))).toBe(false);
    expect(seen.some((s) => /api_exposure/i.test(s))).toBe(true);
  });

  it('is null for any actor but an operator', async () => {
    const mod = await import('./composition/ops-agents');
    expect(await mod.readExposure(rig.buyerA)).toBeNull();
    expect(await mod.readExposure(rig.harbour)).toBeNull();
  });

  it('the row equals the newest api_exposure journal event of the group, after an off and an on', async () => {
    await post(off.POST, noMfa, 'webhooks', 'partner_request');
    await rig.app.db.query('DELETE FROM rate_buckets');
    await post(on.POST, op, 'webhooks', 'maintenance');
    await post(off.POST, noMfa, 'catalogue', 'incident');
    for (const g of ['webhooks', 'catalogue']) {
      const row = (
        await rig.app.db.query<{
          enabled: boolean;
          changed_by: string;
          changed_at: Date | string;
          reason_code: string;
        }>('SELECT enabled, changed_by, changed_at, reason_code FROM api_exposure WHERE group_name = $1', [g])
      ).rows[0]!;
      const ev = (
        await rig.app.db.query<{
          occurred_at: Date | string;
          body: { cols: Record<string, [unknown, unknown]>; hashed: Record<string, [unknown, string]> };
        }>(
          "SELECT occurred_at, body FROM trace_events WHERE source_table = 'api_exposure' AND source_id = $1 ORDER BY seq DESC LIMIT 1",
          [g],
        )
      ).rows[0]!;
      expect(ev.body.cols['enabled']![1], g).toBe(row.enabled);
      expect(ev.body.cols['reason_code']![1], g).toBe(row.reason_code);
      expect(ev.body.hashed['changed_by']![1], g).toBe(
        createHash('sha256').update(row.changed_by).digest('hex'),
      );
      expect(new Date(ev.occurred_at).toISOString(), g).toBe(new Date(row.changed_at).toISOString());
    }
  });
});
