// INT-AL AL.8 (PG-2 exception, R2-5): two operators offer a refund on ONE case at the same moment, on a real
// Postgres 16 (a throwaway server on a unix socket). Each round is a fresh database and a fresh app with the C
// rig's fake Wire. After every round: exactly one refund request exists for the unit, one racer was told 200
// and the other 409, and the case is refund_pending once. Runs only when UMS_TEST_PG_BIN is set; the gate runs
// it by hand, and a skip there is a fail.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buy, call } from '../mvp-c/c-support';
import { PG_ON, assertNoRejection, bootPgRig, race, seeded, startTestPostgres } from './pg-support';
import type { TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

const ROUNDS = 20;

describe.skipIf(!PG_ON)('case refund race on real Postgres (AL.8)', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  let ran = 0;
  it(`two concurrent offer_refund calls on one case: ${ROUNDS} rounds, one refund request each`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const rnd = seeded(7000 + round);
      const pr = await bootPgRig(server);
      try {
        const { rig } = pr;
        const bought = await buy(rig, { offer: 'knot-notebook', option: 'online_read' });
        const at = new Date().toISOString();
        await rig.app.db.query(
          `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
           SELECT 'cas_race', 'refund_requested', 'open', $1, NULL, buyer_id, 'buyer', $2, 0, 'We have your request.', $2, $2 FROM orders WHERE id = $1`,
          [bought.order_id, at],
        );
        const route = await import('../../apps/web/src/app/api/ops/cases/[id]/actions/route');
        const [s1, s2] = [await rig.operator('vikram'), await rig.operator('sakthi')];
        const go = (s: typeof s1, n: number) => () =>
          call(route.POST as never, {
            url: '/api/ops/cases/cas_race/actions',
            method: 'POST',
            body: { action: 'offer_refund', reason: 'goodwill refund' },
            session: s,
            params: { id: 'cas_race' },
            headers: { 'idempotency-key': `race-${round}-${n}-abcdefgh` },
          });
        const results = await race(rnd, [go(s1, 1), go(s2, 2)]);
        assertNoRejection(results, `round ${round}`);
        const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0)).sort();
        expect(statuses, `round ${round}`).toEqual([200, 409]);
        expect(
          await rig.count('SELECT count(*) AS c FROM refund_requests WHERE unit_id = $1', [bought.unit_id]),
          `round ${round}`,
        ).toBe(1);
        expect(
          await rig.count("SELECT count(*) AS c FROM recovery_cases WHERE id = 'cas_race' AND state = 'refund_pending'"),
        ).toBe(1);
        ran += 1;
      } finally {
        await pr.close();
      }
    }
    expect(ran).toBe(ROUNDS);
  }, 600_000);
});
