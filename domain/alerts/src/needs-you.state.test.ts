// INT-AL AL.6 (domain part): the sources of the needs-you list and their counts. The route shape and the href
// check against OPS_PAGES are in apps/web/src/v1-needs-you.contract.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeAlert, needsYou, resolveAlert } from './index';
import { ctxOf, makeWorld } from './world';
import type { World } from './world';

let w: World;
beforeEach(async () => {
  w = await makeWorld('al-ny');
  await w.order(1);
  w.as(ctxOf());
});
afterEach(async () => w.close());

const count = async (kind: string): Promise<number> =>
  (await needsYou(w.db)).filter((r) => r.kind === kind).reduce((n, r) => n + r.count, 0);

describe('needs-you (AL.6)', () => {
  it('is empty when nothing waits', async () => {
    expect(await needsYou(w.db)).toEqual([]);
  });

  it('counts open alerts by severity, and not resolved ones', async () => {
    const a = await w.alert({ kind: 'payment_unresolved', order: 1, unit: 1, reason: 'a' });
    await w.alert({ kind: 'frozen_order', order: 1, unit: 1, reason: 'b' });
    await w.alert({ kind: 'reversal_hint', order: 1, unit: 1, reason: 'c' });
    const rows = await needsYou(w.db);
    const alertRows = rows.filter((r) => r.kind === 'open_alerts');
    expect(alertRows.reduce((n, r) => n + r.count, 0)).toBe(3);
    expect(alertRows.length).toBeGreaterThanOrEqual(2); // more than one severity
    await resolveAlert(w.deps, { alert_id: a, reason_code: 'fixed_upstream' });
    expect(await count('open_alerts')).toBe(2);
    // an acknowledged alert is still waiting on someone
    await acknowledgeAlert(w.deps, { alert_id: (await w.raw.query<{ id: string }>("SELECT id FROM alerts WHERE kind = 'frozen_order'")).rows[0]!.id });
    expect(await count('open_alerts')).toBe(2);
  });

  it('counts applicants with no decision; a rejected applicant keeps status applied and is not counted (R2-3)', async () => {
    await w.applicant('pub_a');
    await w.applicant('pub_b', 'rejected');
    await w.applicant('pub_c', 'approved');
    expect(await count('applicants_waiting')).toBe(1);
  });

  it('counts payee checks with no decision', async () => {
    await w.payeeRequest('pcr_1', 'pub_1');
    await w.payeeRequest('pcr_2', 'pub_1', true);
    expect(await count('payee_checks_waiting')).toBe(1);
  });

  it('counts caps near the limit as the open mandate_near_cap alerts', async () => {
    await w.alert({ kind: 'mandate_near_cap', reason: 'cap90_man_1' });
    await w.alert({ kind: 'mandate_near_cap', reason: 'cap90_man_2' });
    expect(await count('caps_near_limit')).toBe(2);
  });

  it('each row has a kind, a sentence, an href and a count above zero', async () => {
    await w.applicant('pub_a');
    await w.alert({ kind: 'payment_unresolved', order: 1, unit: 1, reason: 'a' });
    for (const r of await needsYou(w.db)) {
      expect(r.sentence.length).toBeGreaterThan(5);
      expect(r.href.startsWith('/')).toBe(true);
      expect(r.count).toBeGreaterThan(0);
    }
  });
});
