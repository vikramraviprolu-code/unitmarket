// API-C (E1, E2): the events service (create, list, remove, deliveries) called directly, and the in-process
// sink that stands in for the HTTP sender. The service is where an operator can create a subscription:
// over HTTP an operator key is refused on every change (W0, mfa_required), so settlement.completed
// subscriptions are made here until a session route exists. The secret comes from the SecretSource and
// never from the seeded Rng.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor, SecretSource } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../composite-support';
import type { App } from '../../composition.server';
import { createEventsService, createInProcessSink, type EventsService } from './events';
import { expectOffline } from './offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

const BYTES = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
const HEX = Buffer.from(BYTES).toString('hex');
const URL_OK = 'https://ops.example.com/hook';
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_svc', mfa: true };

let app: App;
let svc: EventsService;
let asked: number[];
let buyerA: Actor;

beforeAll(async () => {
  app = await bootPackApp();
  asked = [];
  const secrets: SecretSource = {
    bytes(len) {
      asked.push(len);
      return BYTES.slice(0, len);
    },
  };
  svc = createEventsService({
    db: app.db,
    clock: app.security.clock,
    ids: app.security.ids,
    secrets,
  });
  buyerA = await buyer(app, 'a');
});

describe('create', () => {
  it('an operator makes a settlement.completed subscription; the secret is whsec_ plus 32 secret-source bytes', async () => {
    asked.length = 0;
    const r = await svc.create(OPERATOR, { url: URL_OK, event_types: ['settlement.completed'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.signing_secret).toBe(`whsec_${HEX}`);
    expect(asked).toEqual([32]);
    expect(r.value.id).toMatch(/^wsb_[0-9a-z]{26}$/);
    const row = await app.db.query<{
      owner_kind: string;
      owner_id: string;
      signing_secret: string;
    }>('SELECT owner_kind, owner_id, signing_secret FROM webhook_subscriptions WHERE id = $1', [
      r.value.id,
    ]);
    expect(row.rows[0]).toEqual({
      owner_kind: 'operator',
      owner_id: 'opr_svc',
      signing_secret: `whsec_${HEX}`,
    });
  });

  it('an operator asking for a buyer event is refused: event_type_not_allowed', async () => {
    const r = await svc.create(OPERATOR, { url: URL_OK, event_types: ['order.paid'] });
    expect(r).toEqual({ ok: false, error: { code: 'event_type_not_allowed' } });
  });

  it('a bad URL or body is invalid_input and writes nothing', async () => {
    const before = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_subscriptions',
    );
    for (const input of [
      { url: 'http://ops.example.com/x', event_types: ['settlement.completed'] },
      { url: URL_OK, event_types: [] },
      { url: URL_OK, event_types: ['settlement.completed', 'settlement.completed'] },
      { url: URL_OK, event_types: ['nope'] },
      { url: URL_OK },
    ]) {
      const r = await svc.create(OPERATOR, input as never);
      expect(r, JSON.stringify(input)).toEqual({ ok: false, error: { code: 'invalid_input' } });
    }
    const after = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_subscriptions',
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('stamps created_at from the clock', async () => {
    const r = await svc.create(buyerA, { url: URL_OK, event_types: ['order.paid'] });
    if (!r.ok) throw new Error('create refused');
    const now = app.security.clock.now().getTime();
    expect(Math.abs(Date.parse(r.value.created_at) - now)).toBeLessThan(60_000);
    expect(r.value.disabled_at).toBeNull();
  });
});

describe('list, remove, deliveries', () => {
  it('lists only the actor’s own, with no secret', async () => {
    const mine = await svc.create(OPERATOR, { url: URL_OK, event_types: ['settlement.completed'] });
    if (!mine.ok) throw new Error('create refused');
    const all = await svc.list(OPERATOR);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.items.map((i) => i.id)).toContain(mine.value.id);
    expect(JSON.stringify(all.value)).not.toContain('whsec_');
    const other = await svc.list(buyerA);
    if (!other.ok) throw new Error('list refused');
    expect(other.value.items.map((i) => i.id)).not.toContain(mine.value.id);
  });

  it('remove disables once and keeps the first disabled_at on a repeat', async () => {
    const made = await svc.create(OPERATOR, { url: URL_OK, event_types: ['settlement.completed'] });
    if (!made.ok) throw new Error('create refused');
    const first = await svc.remove(OPERATOR, made.value.id);
    const second = await svc.remove(OPERATOR, made.value.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.disabled_at).not.toBeNull();
    expect(second.value.disabled_at).toBe(first.value.disabled_at);
  });

  it('remove and deliveries answer not_found for a missing id and for someone else’s', async () => {
    const made = await svc.create(OPERATOR, { url: URL_OK, event_types: ['settlement.completed'] });
    if (!made.ok) throw new Error('create refused');
    for (const id of [made.value.id, 'wsb_00000000000000000000000000']) {
      const actor = id === made.value.id ? buyerA : OPERATOR;
      expect(await svc.remove(actor, id)).toEqual({ ok: false, error: { code: 'not_found' } });
      expect(await svc.deliveries(actor, id)).toEqual({ ok: false, error: { code: 'not_found' } });
    }
  });

  it('deliveries of a new subscription is an empty page', async () => {
    const made = await svc.create(OPERATOR, { url: URL_OK, event_types: ['settlement.completed'] });
    if (!made.ok) throw new Error('create refused');
    const d = await svc.deliveries(OPERATOR, made.value.id);
    expect(d).toEqual({ ok: true, value: { items: [], next_cursor: null } });
  });
});

describe('the in-process sink', () => {
  const req = (n: number) => ({
    url: `https://sink.example.com/${String(n)}`,
    headers: { 'UnitMarket-Event-Id': `evt_${String(n)}` },
    body: `{"n":${String(n)}}`,
  });

  it('records each send as it was given and answers ok by default', async () => {
    const sink = createInProcessSink();
    expect(await sink.send(req(1))).toEqual({ ok: true });
    expect(await sink.send(req(2))).toEqual({ ok: true });
    expect(sink.records).toEqual([req(1), req(2)]);
  });

  it('answers scripted outcomes in order, then ok again', async () => {
    const sink = createInProcessSink();
    sink.script({ ok: false, error: 'timeout' }, { ok: false, error: 'http_5xx' });
    expect(await sink.send(req(1))).toEqual({ ok: false, error: 'timeout' });
    expect(await sink.send(req(2))).toEqual({ ok: false, error: 'http_5xx' });
    expect(await sink.send(req(3))).toEqual({ ok: true });
    expect(sink.records).toHaveLength(3);
  });

  it('a failed send is still recorded: the sink shows what was attempted', async () => {
    const sink = createInProcessSink();
    sink.script({ ok: false, error: 'connection' });
    await sink.send(req(1));
    expect(sink.records).toEqual([req(1)]);
  });

  it('clear empties the records and the script', async () => {
    const sink = createInProcessSink();
    sink.script({ ok: false, error: 'timeout' });
    await sink.send(req(1));
    sink.clear();
    expect(sink.records).toEqual([]);
    expect(await sink.send(req(2))).toEqual({ ok: true });
  });

  it('a record cannot be changed from outside to change what the sink holds', async () => {
    const sink = createInProcessSink();
    const r = req(1);
    await sink.send(r);
    r.headers['UnitMarket-Event-Id'] = 'tampered';
    expect(sink.records[0]!.headers['UnitMarket-Event-Id']).toBe('evt_1');
  });
});
