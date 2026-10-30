// PUB-D adversarial (docs/specs/pub-d-ops-publishers.md): the suspend route and the page data under
// attack. A publisher, a buyer and an anonymous caller cannot suspend or read; an operator without the
// second factor gets mfa_required; CSRF, mass assignment, size and rate caps hold; a refused call
// changes nothing and a successful one leaves one audit row.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorOf } from './refund-support';
import { bootPayeeWorld } from './payee-support';
import type { PayeeWebWorld } from './payee-support';
import { call } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let w: PayeeWebWorld;
let route: typeof import('./app/api/ops/publishers/status/route');
beforeAll(async () => {
  w = await bootPayeeWorld();
  route = await import('./app/api/ops/publishers/status/route');
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const post = (
  session: Session | null,
  body: unknown,
  o: { csrf?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> =>
  call(route.POST as Handler, {
    url: '/api/ops/publishers/status',
    method: 'POST',
    body,
    session,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
    ...(o.headers === undefined ? {} : { headers: o.headers }),
  });
const good = () => ({
  publisher_id: w.pubId['northfield-quarterly'],
  status: 'suspended',
  reason: 'Attack test reason',
});
const statusOf = async (id: string): Promise<string> =>
  (await w.app.db.query<{ status: string }>('SELECT status FROM publishers WHERE id = $1', [id]))
    .rows[0]!.status;
const audits = async (): Promise<number> =>
  Number(
    (
      await w.app.db.query<{ c: string }>(
        "SELECT count(*) AS c FROM audit_log WHERE action LIKE 'publisher.%'",
      )
    ).rows[0]!.c,
  );

describe('who may suspend', () => {
  it('an operator without the second factor gets 403 mfa_required and nothing changes', async () => {
    const res = await post(w.refund.demo, good());
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
    expect(await statusOf(w.pubId['northfield-quarterly'])).toBe('active');
  });

  it('a publisher session, a buyer session and no session cannot suspend, not even themselves', async () => {
    expect((await post(w.pub['northfield-quarterly'], good())).status).toBe(403);
    expect((await post(w.pub['harbour-ledger'], good())).status).toBe(403);
    expect((await post(w.refund.A, good())).status).toBe(403);
    expect((await post(null, good())).status).toBe(401);
    expect(await statusOf(w.pubId['northfield-quarterly'])).toBe('active');
    expect(await audits()).toBe(0);
  });

  it('the page data refuses a publisher, a buyer and a system actor', async () => {
    for (const actor of [
      { kind: 'publisher', publisher_id: w.pubId['harbour-ledger'] },
      w.refund.actorA,
      { kind: 'system' },
    ] as const) {
      const r = await w.app.engine.opsPublishers.list(actor);
      expect(r.ok).toBe(false);
    }
  });
});

describe('the shape of the call', () => {
  it('a missing CSRF token is 403 csrf', async () => {
    const res = await post(w.refund.op, good(), { csrf: false });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('csrf');
    expect(await statusOf(w.pubId['northfield-quarterly'])).toBe('active');
  });

  it('mass assignment: an extra field is refused by the strict shape', async () => {
    for (const extra of [
      { status_override: 'active' },
      { payee_verified_at: '2026-10-30T00:00:00.000Z' },
      { paypal_merchant_id: 'AAAAAAAAAAAAA' },
    ]) {
      const res = await post(w.refund.op, { ...good(), ...extra });
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe('invalid_input');
    }
    expect(await statusOf(w.pubId['northfield-quarterly'])).toBe('active');
  });

  it('only suspended and active are accepted, and the reason is 3 to 200 characters', async () => {
    for (const bad of [
      { status: 'applied' },
      { status: 'deleted' },
      { status: '' },
      { reason: 'x' },
      { reason: 'y'.repeat(201) },
      { reason: '   ' },
      { publisher_id: '' },
      { publisher_id: 5 },
    ]) {
      const res = await post(w.refund.op, { ...good(), ...bad });
      expect(res.status).toBe(422);
    }
    expect(await statusOf(w.pubId['northfield-quarterly'])).toBe('active');
  });

  it('an oversized body is 413', async () => {
    const res = await post(w.refund.op, { ...good(), reason: 'z'.repeat(3000) });
    expect(res.status).toBe(413);
  });

  it('an applicant cannot be activated through this route', async () => {
    await w.app.db.query("UPDATE publishers SET status = 'applied' WHERE id = $1", [
      w.pubId['quayside-gazette'],
    ]);
    const res = await post(w.refund.op, {
      publisher_id: w.pubId['quayside-gazette'],
      status: 'active',
      reason: 'Approve applicant',
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_allowed');
    expect(await statusOf(w.pubId['quayside-gazette'])).toBe('applied');
    await w.app.db.query("UPDATE publishers SET status = 'active' WHERE id = $1", [
      w.pubId['quayside-gazette'],
    ]);
  });
});

describe('what a successful call leaves', () => {
  it('one audit row naming the operator and the reason, and no merchant id anywhere in it', async () => {
    const before = await audits();
    const res = await post(w.refund.op, good());
    expect(res.status).toBe(200);
    expect(await audits()).toBe(before + 1);
    const row = (
      await w.app.db.query<Record<string, unknown>>(
        "SELECT actor_kind, actor_id, action, target, reason, detail FROM audit_log WHERE action = 'publisher.suspended' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      target: w.pubId['northfield-quarterly'],
      reason: 'Attack test reason',
    });
    const merchants = (
      await w.app.db.query<{ m: string }>(
        'SELECT paypal_merchant_id AS m FROM publishers WHERE paypal_merchant_id IS NOT NULL',
      )
    ).rows.map((r) => r.m);
    for (const m of merchants) expect(JSON.stringify(row)).not.toContain(m);
  });

  it('is rate limited to 20 changes an hour per operator', async () => {
    let limited = 0;
    for (let i = 0; i < 22; i += 1) {
      const res = await post(w.refund.op2, {
        publisher_id: w.pubId['northfield-quarterly'],
        status: i % 2 === 0 ? 'active' : 'suspended',
        reason: `Toggle number ${String(i)}`,
      });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(2);
  });
});

describe('the route file', () => {
  it('declares an operator route with CSRF, a per actor rate and a strict body', async () => {
    expect(route.routeMeta).toMatchObject({
      path: '/api/ops/publishers/status',
      method: 'POST',
      auth: 'operator',
      csrf: true,
    });
    expect(route.routeMeta.rate).toMatchObject({ per: 'actor', limit: 20, window_ms: 3_600_000 });
  });
});
