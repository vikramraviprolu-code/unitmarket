import { afterEach, describe, expect, it } from 'vitest';
import { CreateOrderResSchema, DomainConfigSchema } from '@umsbx/contracts';
import { createReqFor, seedTestCatalogue, testDb, testDeps } from './index';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('testDb', () => {
  it('testDb is migrated and isolated per call', async () => {
    const a = await testDb();
    const b = await testDb();
    closers.push(
      () => a.close(),
      () => b.close(),
    );
    const migrations = await a.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations',
    );
    expect(migrations.rows[0]?.n).toBeGreaterThanOrEqual(6);
    // seeded: corridor, access policies and the seven switches (paypal_outbound off)
    const corridor = await a.query('SELECT id FROM corridors WHERE id = $1', ['us-usd']);
    expect(corridor.rows).toHaveLength(1);
    const policies = await a.query('SELECT id FROM access_policies');
    expect(policies.rows.length).toBeGreaterThan(0);
    const sw = await a.query<{ name: string; on: boolean }>(
      'SELECT name, "on" FROM safety_switches ORDER BY name',
    );
    expect(sw.rows).toHaveLength(7); // API-B added agent_buy_enabled
    expect(sw.rows.find((r) => r.name === 'paypal_outbound')?.on).toBe(false);
    // isolated: a write in one database is invisible in the other
    await seedTestCatalogue(a);
    const inA = await a.query<{ n: number }>('SELECT count(*)::int AS n FROM publishers');
    const inB = await b.query<{ n: number }>('SELECT count(*)::int AS n FROM publishers');
    expect(inA.rows[0]?.n).toBeGreaterThan(0);
    expect(inB.rows[0]?.n).toBe(0);
  });
});

describe('seedTestCatalogue', () => {
  it('returns authorised offer ids and publisher ids that exist', async () => {
    const db = await testDb();
    closers.push(() => db.close());
    const { offer_ids, publisher_ids } = await seedTestCatalogue(db);
    expect(offer_ids.length).toBeGreaterThan(0);
    expect(publisher_ids).toHaveLength(2);
    const pubs = await db.query<{ id: string }>('SELECT id FROM publishers');
    expect(pubs.rows.map((r) => r.id).sort()).toEqual([...publisher_ids].sort());
    const offers = await db.query<{ id: string }>(
      "SELECT DISTINCT id FROM offers WHERE status = 'authorised'",
    );
    expect(offers.rows.map((r) => r.id).sort()).toEqual([...offer_ids].sort());
  });
});

describe('testDeps', () => {
  it('testDeps transport is dry-run and every call is recorded', async () => {
    const deps = await testDeps({ scenario: 'happy' });
    closers.push(() => deps.db.close());
    expect(deps.transport.kind).toBe('dryrun');
    expect(deps.environment).toBe('dryrun');
    expect(deps.paypal.environment).toBe('dryrun');
    expect(deps.calls()).toHaveLength(0);
    const res = CreateOrderResSchema.parse(await deps.paypal.createOrder(createReqFor('happy')));
    expect(res.kind).toBe('created');
    const calls = deps.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe('create_order');
    expect(calls[0]?.method).toBe('POST');
    // a call with no fixture is blocked, not sent, and still recorded
    await deps.paypal.getCapture('SBXNOFIXTURE00001', 'no_such_scenario');
    expect(deps.calls().length).toBeGreaterThanOrEqual(2);
  });

  it('testDeps clock and ids are deterministic and the config is a valid DomainConfig', async () => {
    const a = await testDeps({ start: '2026-10-21T10:00:00.000Z' });
    const b = await testDeps({ start: '2026-10-21T10:00:00.000Z' });
    closers.push(
      () => a.db.close(),
      () => b.db.close(),
    );
    expect(a.clock.now().toISOString()).toBe('2026-10-21T10:00:00.000Z');
    a.clock.advance(60_000);
    expect(a.clock.now().toISOString()).toBe('2026-10-21T10:01:00.000Z');
    expect(a.ids.next('ord')).toBe(b.ids.next('ord'));
    expect(DomainConfigSchema.safeParse(a.config).success).toBe(true);
    expect(await a.switches.isOn('checkout_enabled')).toBe(true);
    expect(await a.switches.isOn('paypal_outbound')).toBe(false);
    expect(await a.content.health()).toBe(true);
    expect(a.model.model_id).toBe('scripted-v1');
  });

  it('testDeps content store serves seeded articles from the database', async () => {
    const deps = await testDeps();
    closers.push(() => deps.db.close());
    await seedTestCatalogue(deps.db);
    const keys = await deps.db.query<{ content_key: string }>('SELECT content_key FROM articles');
    const key = keys.rows[0]?.content_key ?? '';
    const head = await deps.content.head(key);
    expect(head?.mime).toBe('text/plain');
    expect(await deps.content.head('no/such/key')).toBeNull();
  });
});
