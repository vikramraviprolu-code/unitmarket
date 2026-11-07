// TR-LINK: the journal records every change of the address a publisher is paid to. requestPaypalLink and
// decidePaypalLink run on a database wrapped with withTraceDb, as the app does; the events of
// publisher_paypal_links must carry the actor, the channel, the mfa flag and the time, and the address only as
// a sha256. PGlite.
import { traceInvariants, verifyTrace, withTraceDb } from '@umsbx/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskEmail, requestPaypalLink, decidePaypalLink } from './paypal-link';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';
import type { LinkDeps } from './paypal-link';
import type { Actor, TraceContext } from '@umsbx/contracts';

const HASH = 'scrypt:16384:8:1:00112233445566778899aabbccddeeff:' + 'a'.repeat(64);
const HEX64 = /^[a-f0-9]{64}$/;
let w: OffersWorld;
let current: TraceContext | undefined;
let deps: LinkDeps;
beforeAll(async () => {
  w = await offersWorld();
  const traced = withTraceDb(w.db, () => current, w.clock);
  deps = { ...w.deps(), db: traced };
});
afterAll(async () => {
  await w.db.close();
});

let n = 0;
const ctxOf = (over: Partial<TraceContext>): TraceContext => {
  n += 1;
  return {
    id: `ctx_link_${String(n).padStart(4, '0')}`,
    at: w.clock.now().toISOString(),
    channel: 'web',
    actor_kind: 'publisher',
    actor_id: null,
    on_behalf_of: null,
    mandate_id: null,
    mfa: false,
    req_id: `req_link_${String(n)}`,
    ip_hash: 'f'.repeat(32),
    ua_family: 'browser',
    api_key_id: null,
    job: null,
    tool: null,
    ...over,
  };
};

/** A new active publisher with a claimed account (written without a context, like the other fixtures). */
async function withAccount(): Promise<{ id: string; actor: Actor }> {
  n += 1;
  const id = `pub_trl${String(n)}`;
  const at = w.clock.now().toISOString();
  await w.db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'GB', 'active', $4, $4)`,
    [id, `trl-pub-${String(n)}`, `Trl Pub ${String(n)}`, at],
  );
  await w.db.query(
    `INSERT INTO publisher_accounts
       (publisher_id, username, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 0, NULL, $4, $4, $4)`,
    [id, `trl.owner.${String(n)}`, HASH, at],
  );
  return { id, actor: { kind: 'publisher', publisher_id: id } };
}

interface Ev {
  chain_key: string;
  seq: number;
  actor_kind: string;
  actor_id: string | null;
  mfa: boolean;
  channel: string | null;
  ctx_id: string | null;
  event_type: string;
  occurred_at: string;
  publisher_id: string | null;
  body: {
    op: string;
    n: number;
    cols: Record<string, [unknown, unknown]>;
    hashed: Record<string, [unknown, unknown]>;
  };
}
const eventsOfLink = async (publisher_id: string): Promise<Ev[]> =>
  (
    await w.db.query<Ev>(
      `SELECT chain_key, seq::int AS seq, actor_kind, actor_id, mfa, channel, ctx_id, event_type,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
              publisher_id, body
         FROM trace_events WHERE source_table = 'publisher_paypal_links' AND source_id = $1
        ORDER BY (body->>'n')::int`,
      [publisher_id],
    )
  ).rows;
const sha = async (text: string): Promise<string> =>
  (
    await w.db.query<{ h: string }>("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h", [
      text,
    ])
  ).rows[0]!.h;
const dump = async (table: string): Promise<string> =>
  (
    await w.db.query<{ t: string }>(
      `SELECT coalesce(string_agg(x::text, E'\\n'), '') AS t FROM ${table} x`,
    )
  ).rows[0]!.t;
const iso = (v: unknown): string => new Date(v as string).toISOString();

describe('the publisher enters an address', () => {
  it('writes one event with the publisher as actor and the hash of the address, and no clear address in any trace table', async () => {
    const p = await withAccount();
    current = ctxOf({ actor_kind: 'publisher', actor_id: p.id, mfa: false });
    w.clock.advance(1000);
    const r = await requestPaypalLink(deps, p.actor, { email: 'Seller.One@Example.com' });
    current = undefined;
    expect(r).toEqual({ ok: true, value: { state: 'requested' } });
    const events = await eventsOfLink(p.id);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      chain_key: `pub:${p.id}`,
      publisher_id: p.id,
      event_type: 'publisher_paypal_links.created',
      actor_kind: 'publisher',
      actor_id: p.id,
      mfa: false,
      channel: 'web',
    });
    expect(e.body.op).toBe('insert');
    expect(e.body.hashed['paypal_email']).toEqual([null, await sha('seller.one@example.com')]);
    expect(e.body.cols['state']).toEqual([null, 'requested']);
    expect(e.body.cols['verified_by']).toEqual([null, null]);
    expect(e.body.cols['verified_at']).toEqual([null, null]);
    expect(Object.keys(e.body.cols).sort()).toEqual(['state', 'verified_at', 'verified_by']);
    expect(e.occurred_at).toBe(
      w.clock
        .now()
        .toISOString()
        .replace(/\.\d+Z$/, 'Z'),
    );
    for (const table of ['trace_events', 'trace_context', 'trace_heads', 'trace_seals']) {
      const text = (await dump(table)).toLowerCase();
      expect(text, table).not.toContain('seller.one');
    }
    expect((await verifyTrace(w.db)).findings).toEqual([]);
  });
});

describe('the publisher changes the address', () => {
  it('writes a second event with another hash; a verified address goes back to requested with the operator check cleared', async () => {
    const p = await withAccount();
    current = ctxOf({ actor_kind: 'publisher', actor_id: p.id });
    await requestPaypalLink(deps, p.actor, { email: 'first@example.com' });
    current = ctxOf({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      mfa: true,
      channel: 'web',
    });
    w.clock.advance(60_000);
    await decidePaypalLink(deps, w.operator, {
      publisher_id: p.id,
      email_retyped: 'first@example.com',
      reason: 'Confirmed by phone',
    });
    current = ctxOf({ actor_kind: 'publisher', actor_id: p.id });
    w.clock.advance(60_000);
    const r = await requestPaypalLink(deps, p.actor, { email: 'second@example.com' });
    current = undefined;
    expect(r).toEqual({ ok: true, value: { state: 'requested' } });
    const events = await eventsOfLink(p.id);
    expect(events.map((e) => e.event_type)).toEqual([
      'publisher_paypal_links.created',
      'publisher_paypal_links.updated',
      'publisher_paypal_links.updated',
    ]);
    const change = events[2]!;
    expect(change).toMatchObject({ actor_kind: 'publisher', actor_id: p.id, mfa: false });
    const [before, after] = change.body.hashed['paypal_email']!;
    expect(before).toBe(await sha('first@example.com'));
    expect(after).toBe(await sha('second@example.com'));
    expect(before).not.toBe(after);
    expect(change.body.cols['state']).toEqual(['verified', 'requested']);
    expect(change.body.cols['verified_by']).toEqual(['opr_vikram', null]);
    expect(change.body.cols['verified_at']![1]).toBeNull();
    expect(events[0]!.body.hashed['paypal_email']![1]).toBe(before);
    expect((await verifyTrace(w.db)).findings).toEqual([]);
  });

  it('finding: the masked audit row cannot tell two addresses with one first letter and domain apart; the journal can', async () => {
    const p = await withAccount();
    current = ctxOf({ actor_kind: 'publisher', actor_id: p.id });
    await requestPaypalLink(deps, p.actor, { email: 'seller@example.com' });
    await requestPaypalLink(deps, p.actor, { email: 'sally@example.com' });
    current = undefined;
    expect(maskEmail('seller@example.com')).toBe(maskEmail('sally@example.com'));
    const audits = (
      await w.db.query<{ detail: { masked: string; changed: boolean } }>(
        `SELECT detail FROM audit_log WHERE target = $1 AND action = 'publisher.paypal_link_requested' ORDER BY created_at, id`,
        [p.id],
      )
    ).rows;
    expect(audits.map((a) => a.detail.masked)).toEqual(['s***@example.com', 's***@example.com']);
    const events = await eventsOfLink(p.id);
    expect(events).toHaveLength(2);
    expect(events[1]!.body.hashed['paypal_email']![0]).not.toBe(
      events[1]!.body.hashed['paypal_email']![1],
    );
  });
});

describe('an operator with the second factor verifies', () => {
  it('shows the operator as actor, mfa true, and copies verified_by and verified_at', async () => {
    const p = await withAccount();
    current = ctxOf({ actor_kind: 'publisher', actor_id: p.id });
    await requestPaypalLink(deps, p.actor, { email: 'owner@example.com' });
    current = ctxOf({ actor_kind: 'operator', actor_id: 'opr_vikram', mfa: true });
    w.clock.advance(5000);
    const r = await decidePaypalLink(deps, w.operator, {
      publisher_id: p.id,
      email_retyped: 'owner@example.com',
      reason: 'Confirmed by phone',
    });
    current = undefined;
    expect(r).toEqual({ ok: true, value: { state: 'verified' } });
    const events = await eventsOfLink(p.id);
    expect(events).toHaveLength(2);
    const e = events[1]!;
    expect(e).toMatchObject({
      event_type: 'publisher_paypal_links.updated',
      chain_key: `pub:${p.id}`,
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      mfa: true,
    });
    expect(e.body.cols['state']).toEqual(['requested', 'verified']);
    expect(e.body.cols['verified_by']).toEqual([null, 'opr_vikram']);
    expect(iso(e.body.cols['verified_at']![1])).toBe(w.clock.now().toISOString());
    // The address did not change: no hashed entry.
    expect(e.body.hashed).toEqual({});
    const row = (
      await w.db.query<{ verified_by: string }>(
        'SELECT verified_by FROM publisher_paypal_links WHERE publisher_id = $1',
        [p.id],
      )
    ).rows[0]!;
    expect(row.verified_by).toBe(e.body.cols['verified_by']![1]);
  });
});

describe('a write with no trace context', () => {
  it('is recorded as unattributed, and trace verify still has no finding', async () => {
    const p = await withAccount();
    current = undefined;
    const r = await requestPaypalLink(deps, p.actor, { email: 'bare@example.com' });
    expect(r).toEqual({ ok: true, value: { state: 'requested' } });
    const events = await eventsOfLink(p.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_kind: 'unattributed',
      actor_id: null,
      mfa: false,
      chain_key: `pub:${p.id}`,
    });
    expect(events[0]!.body.hashed['paypal_email']![1]).toBe(await sha('bare@example.com'));
    expect((await verifyTrace(w.db)).findings).toEqual([]);
    // INV-T2 reports bare writes (the fixtures write some too, so the list is cut); INV-T1 (the journal itself) is intact.
    const inv = await traceInvariants(w.db);
    expect(inv.some((l) => l.startsWith('INV-T1'))).toBe(false);
    expect(inv.some((l) => l.startsWith('INV-T2'))).toBe(true);
  });
});
