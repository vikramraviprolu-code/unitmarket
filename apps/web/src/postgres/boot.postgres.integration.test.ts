// PG-2: the web app on UMS_DB=postgres against a throwaway real Postgres 16 (unix socket, temp dir).
// It boots, migrates, serves /healthz and completes one dry-run purchase; no URL reaches any log.
// Runs only when UMS_TEST_PG_BIN is set.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, installApp } from '../../composition.server';
import type { App } from '../../composition.server';
import { call, testEnv } from '../support';
import { pgBinConfigured, startTestPostgres } from '../../../../packages/db/src/pg-testing';
import type { TestPostgres, TestDatabase } from '../../../../packages/db/src/pg-testing';

vi.mock('server-only', () => ({}));

describe.skipIf(!pgBinConfigured())('PG-2 app boot on UMS_DB=postgres', () => {
  let server: TestPostgres;
  let database: TestDatabase;
  let app: App;
  const lines: string[] = [];
  beforeAll(async () => {
    server = await startTestPostgres();
    database = await server.createDatabase('ums_web');
    app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: database.url }), {
      switch_cache_ms: 0,
      log_sink: (l) => lines.push(l),
    });
    installApp(app);
    await app.ready();
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await server?.stop();
  });

  it('boots on Postgres: the driver is pg and the schema is migrated and seeded', async () => {
    expect(app.config.db.kind).toBe('postgres');
    expect(app.db.dialect).toBe('pg');
    const r = await app.db.query<{ c: string }>('SELECT count(*) AS c FROM publishers');
    expect(Number(r.rows[0]?.c)).toBeGreaterThan(0);
  });

  it('/healthz answers ok', async () => {
    const { GET } = await import('../app/healthz/route');
    const res = await call(GET as never, { url: '/healthz' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, environment: 'dryrun' });
  });

  it('one dry-run purchase completes and the seven invariants hold', async () => {
    const buyer = (
      await app.db.query<{ id: string }>(
        `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
      )
    ).rows[0]!;
    const actor = { kind: 'buyer', buyer_id: buyer.id } as const;
    const offer = (await app.engine.listOffers()).find(
      (o) => o.publisher_slug === 'harbour-ledger',
    )!;
    const page = await app.engine.offerPage({
      publisher: 'harbour-ledger',
      offer: offer.offer_code,
    });
    const q = await app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: offer.offer_code },
      actor,
      source: 'direct',
      option: page!.options[0]!.option,
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    const g = await app.engine.requestApproval({
      actor,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error('no approval');
    const placed = await app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor,
    });
    if (!placed.ok) throw new Error('place failed');
    const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
    if (!co.ok) throw new Error('checkout failed');
    expect(
      await app.engine.dryRunApprove({
        order_ref: placed.value.order_ref,
        actor,
        scenario: 'happy',
      }),
    ).toBe(true);
    await app.engine.payments.onBuyerReturn({
      order_ref: placed.value.order_ref,
      actor,
      scenario: 'happy',
    });
    const view = await app.engine.orderView({ order_ref: placed.value.order_ref, actor });
    expect(view?.status).toBe('paid');
    const ops = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(ops?.invariants.every((v) => v.ok)).toBe(true);
  }, 60_000);

  it('no log line carries the connection URL, the socket directory or the user', async () => {
    const all = lines.join('\n');
    expect(all).not.toContain(database.url);
    expect(all).not.toContain(server.socketDir);
    expect(all).not.toContain(encodeURIComponent(server.socketDir));
    expect(all).not.toContain('postgres://');
  });

  it('an unreachable server fails the boot with a fixed message that never prints the URL', async () => {
    const url = `postgres://nobody:s3cretpass@:54329/nodb?host=${encodeURIComponent('/nonexistent-dir-pg2')}`;
    const bad = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: url }), {
      switch_cache_ms: 0,
    });
    const e = await bad.ready().then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(e).not.toBeNull();
    const text = `${e?.message ?? ''}\n${e?.stack ?? ''}`;
    expect(text).toMatch(/database connection failed/);
    for (const needle of ['s3cretpass', 'nobody', 'nonexistent-dir-pg2', 'postgres://'])
      expect(text).not.toContain(needle);
    await bad.close().catch(() => undefined);
  });
});
