// API-B (G1) on a real Postgres 16: the mandate cap under racing connections. PGlite runs one query at a
// time, so only a real server proves that the conditional UPDATE in reserve is the whole guard. Each round
// is a fresh database with the C rig; the racers start in a seeded order. Runs only when UMS_TEST_PG_BIN is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import { commit, release, reserve } from '@umsbx/mandates';
import type { MandateDeps } from '@umsbx/mandates';
import { apiKeyDeps, createApiV1 } from '../../apps/web/composition.server';
import { PG_ON, assertNoRejection, bootPgRig, race, seeded, startTestPostgres } from './pg-support';
import type { PgRig, TestPostgres } from './pg-support';

vi.mock('server-only', () => ({}));

const ROUNDS = 10;
const RACERS = 20;

describe.skipIf(!PG_ON)('API-B mandate cap on real Postgres', () => {
  let server: TestPostgres;
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await server?.stop();
  });

  const inFuture = (pr: PgRig, days = 30) =>
    new Date(pr.rig.app.security.clock.now().getTime() + days * 86_400_000).toISOString();

  async function agentWithMandate(
    pr: PgRig,
    caps: {
      max_total_minor?: number | null;
      max_count?: number | null;
      max_per_purchase_minor?: number | null;
    },
  ) {
    const { app, buyer } = pr.rig;
    if (buyer.kind !== 'buyer') throw new Error('buyer expected');
    const key = await issueKey(apiKeyDeps(app), {
      owner: buyer,
      key_kind: 'agent',
      scopes: ['catalogue:read', 'agent:buy'],
    });
    if (!key.ok) throw new Error(`key refused: ${key.error}`);
    const made = await createApiV1(app).mandates.create({
      buyer_id: buyer.buyer_id,
      agent_key_id: key.value.id,
      currency: 'USD',
      max_total_minor: caps.max_total_minor ?? null,
      max_count: caps.max_count ?? null,
      max_per_purchase_minor: caps.max_per_purchase_minor ?? null,
      expires_at: inFuture(pr),
    });
    if (!made.ok) throw new Error(`mandate refused: ${made.error}`);
    return { buyer_id: buyer.buyer_id, agent_key_id: key.value.id, mandate_id: made.value.id };
  }

  const depsOf = (pr: PgRig): MandateDeps => ({
    clock: pr.rig.app.security.clock,
    ids: pr.rig.app.security.ids,
    outbox: createApiV1(pr.rig.app).events,
    audit: pr.rig.app.security.audit,
  });

  const reserveOnce = (
    pr: PgRig,
    m: Awaited<ReturnType<typeof agentWithMandate>>,
    amount_minor: number,
  ) =>
    pr.rig.app.db.transaction((tx) =>
      reserve(tx, depsOf(pr), {
        mandate_id: m.mandate_id,
        buyer_id: m.buyer_id,
        agent_key_id: m.agent_key_id,
        amount_minor,
        currency: 'USD',
      }),
    );

  const totals = async (pr: PgRig, id: string) => {
    const r = await pr.rig.app.db.query<{
      spent_minor: string | number;
      used_count: string | number;
    }>('SELECT spent_minor, used_count FROM mandates WHERE id = $1', [id]);
    return { spent: Number(r.rows[0]!.spent_minor), used: Number(r.rows[0]!.used_count) };
  };

  it(`${RACERS} racing reserves on a 5-purchase cap book exactly 5 (${ROUNDS} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const pr = await bootPgRig(server);
      try {
        const m = await agentWithMandate(pr, { max_count: 5 });
        const results = await race(
          seeded(7000 + round),
          Array.from({ length: RACERS }, () => () => reserveOnce(pr, m, 10)),
        );
        assertNoRejection(results, `count round ${round}`);
        const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
        expect(ok).toBe(5);
        expect(await totals(pr, m.mandate_id)).toEqual({ spent: 50, used: 5 });
        const held = await pr.rig.count(
          "SELECT count(*) AS c FROM mandate_reservations WHERE mandate_id = $1 AND state = 'held'",
          [m.mandate_id],
        );
        expect(held).toBe(5);
      } finally {
        await pr.close();
      }
    }
  }, 300_000);

  it(`${RACERS} racing reserves of 30 on a 100 money cap book exactly 3 (${ROUNDS} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const pr = await bootPgRig(server);
      try {
        const m = await agentWithMandate(pr, { max_total_minor: 100 });
        const results = await race(
          seeded(8000 + round),
          Array.from({ length: RACERS }, () => () => reserveOnce(pr, m, 30)),
        );
        assertNoRejection(results, `money round ${round}`);
        expect(results.filter((r) => r.status === 'fulfilled' && r.value.ok).length).toBe(3);
        expect(await totals(pr, m.mandate_id)).toEqual({ spent: 90, used: 3 });
      } finally {
        await pr.close();
      }
    }
  }, 300_000);

  it('racing release and commit of one reservation: one wins, the counters stay in range', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const pr = await bootPgRig(server);
      try {
        const m = await agentWithMandate(pr, { max_count: 2 });
        const first = await reserveOnce(pr, m, 10);
        if (!first.ok) throw new Error('first reserve refused');
        const id = first.value.reservation_id;
        const results = await race(seeded(9000 + round), [
          () => pr.rig.app.db.transaction((tx) => release(tx, depsOf(pr), id)),
          () => pr.rig.app.db.transaction((tx) => commit(tx, depsOf(pr), id)),
          () => pr.rig.app.db.transaction((tx) => release(tx, depsOf(pr), id)),
          () => pr.rig.app.db.transaction((tx) => commit(tx, depsOf(pr), id)),
        ]);
        assertNoRejection(results, `settle round ${round}`);
        const won = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
        expect(won).toBe(1);
        const state = await pr.rig.app.db.query<{ state: string }>(
          'SELECT state FROM mandate_reservations WHERE id = $1',
          [id],
        );
        const t = await totals(pr, m.mandate_id);
        if (state.rows[0]!.state === 'released') expect(t).toEqual({ spent: 0, used: 0 });
        else expect(t).toEqual({ spent: 10, used: 1 });
      } finally {
        await pr.close();
      }
    }
  }, 300_000);

  it('racing mandate creation for one agent key makes exactly one open mandate', async () => {
    for (let round = 0; round < 5; round += 1) {
      const pr = await bootPgRig(server);
      try {
        const first = await agentWithMandate(pr, { max_count: 1 });
        // the first is revoked so every racer starts from "no open mandate"
        await createApiV1(pr.rig.app).mandates.revoke(first.buyer_id, first.mandate_id);
        const results = await race(
          seeded(9500 + round),
          Array.from(
            { length: 8 },
            () => () =>
              createApiV1(pr.rig.app).mandates.create({
                buyer_id: first.buyer_id,
                agent_key_id: first.agent_key_id,
                currency: 'USD',
                max_total_minor: null,
                max_count: 3,
                max_per_purchase_minor: null,
                expires_at: inFuture(pr),
              }),
          ),
        );
        assertNoRejection(results, `create round ${round}`);
        const made = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
        expect(made).toBe(1);
        const open = await pr.rig.count(
          'SELECT count(*) AS c FROM mandates WHERE agent_key_id = $1 AND revoked_at IS NULL',
          [first.agent_key_id],
        );
        expect(open).toBe(1);
      } finally {
        await pr.close();
      }
    }
  }, 300_000);
});
