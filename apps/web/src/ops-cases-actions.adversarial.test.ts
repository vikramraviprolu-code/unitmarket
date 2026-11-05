// INT-AL AL.8: POST /api/ops/cases/[id]/actions. The six actions reuse domain/recovery and the existing refund
// path. An operator session with the second factor, CSRF and an Idempotency-Key; buyers, sellers and keys are
// refused; an action the state does not allow is 409 wrong_state; every action is journaled with the operator.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import { buy, bootRefundWorld, count, errorOf } from './refund-support';
import type { BoughtUnit, RefundWorld } from './refund-support';
import { call } from './support';
import type { Session } from './support';
import { key } from './ops-alerts-support';

vi.mock('server-only', () => ({}));

type Handler = Parameters<typeof call>[0];
let w: RefundWorld;
let route: { POST: Handler };
let seller: Session;
const u: Record<string, BoughtUnit> = {};
const url = (id: string): string => `/api/ops/cases/${id}/actions`;

const act = (
  id: string,
  session: Session | null,
  body: unknown,
  o: { idem?: string | null; csrf?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> =>
  call(route.POST, {
    url: url(id),
    method: 'POST',
    body,
    session,
    params: { id },
    headers: {
      ...(o.idem === null ? {} : { 'idempotency-key': o.idem ?? key() }),
      ...(o.headers ?? {}),
    },
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });

async function seedCase(id: string, unit: BoughtUnit, state = 'open'): Promise<void> {
  const at = '2026-11-05T10:00:00.000Z';
  await w.app.db.query(
    `INSERT INTO recovery_cases (id, kind, state, order_id, entitlement_id, buyer_id, opened_by, sla_due_at, credit_ms, buyer_message, created_at, updated_at)
     SELECT $1::text, 'refund_requested', $3::text, id, NULL, buyer_id, 'buyer', $4::timestamptz, 0, 'We have your request.', $4::timestamptz, $4::timestamptz FROM orders WHERE id = $2`,
    [id, unit.order_id, state, at],
  );
}
const caseState = async (id: string): Promise<string> =>
  (await w.app.db.query<{ state: string }>('SELECT state FROM recovery_cases WHERE id = $1', [id]))
    .rows[0]!.state;

beforeAll(async () => {
  w = await bootRefundWorld();
  route = (await import('./app/api/ops/cases/[id]/actions/route')) as never;
  u['a'] = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
  u['b'] = await buy(w, { offer: 'harbour-fees', option: 'online_read' });
  u['c'] = await buy(w, { offer: 'ferry-timetables', option: 'online_read' });
  u['d'] = await buy(w, { offer: 'tide-tables', option: 'online_read' });
  const pub = (
    await w.app.db.query<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'")
  ).rows[0]!.id;
  const s = await createSession(w.app.security, { kind: 'publisher', publisher_id: pub });
  seller = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
  await seedCase('cas_a', u['a']!);
  await seedCase('cas_b', u['b']!);
  await seedCase('cas_c', u['c']!);
  await seedCase('cas_d', u['d']!, 'closed_no_fault');
});
afterAll(async () => w.app.close());

describe('who may act', () => {
  it('an operator without the second factor gets 403 mfa_required, and nothing moves', async () => {
    const res = await act('cas_a', w.demo, { action: 'offer_refund', reason: 'goodwill refund' });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
    expect(await count(w.app, 'SELECT count(*) AS c FROM refund_requests')).toBe(0);
    expect(await caseState('cas_a')).toBe('open');
  });

  it('buyer and seller sessions, no session and a bearer key are refused', async () => {
    const body = { action: 'offer_refund', reason: 'goodwill refund' };
    expect([401, 403]).toContain((await act('cas_a', w.A, body)).status);
    expect([401, 403]).toContain((await act('cas_a', seller, body)).status);
    expect((await act('cas_a', null, body)).status).toBe(401);
    const token = await (async () => {
      const { issueKey } = await import('@umsbx/security');
      const { apiKeyDeps } = await import('../composition.server');
      const r = await issueKey(apiKeyDeps(w.app), {
        owner: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
        key_kind: 'api_client',
        scopes: ['ops:read'],
      });
      if (!r.ok) throw new Error('no key');
      return r.value.token;
    })();
    expect([401, 403]).toContain(
      (await act('cas_a', null, body, { headers: { authorization: `Bearer ${token}` } })).status,
    );
    expect(await count(w.app, 'SELECT count(*) AS c FROM refund_requests')).toBe(0);
  });

  it('a missing CSRF token is 403 and a missing Idempotency-Key is 422', async () => {
    const body = { action: 'offer_refund', reason: 'goodwill refund' };
    expect((await act('cas_a', w.op, body, { csrf: false })).status).toBe(403);
    expect((await act('cas_a', w.op, body, { idem: null })).status).toBe(422);
    expect(await count(w.app, 'SELECT count(*) AS c FROM refund_requests')).toBe(0);
  });
});

describe('what an operator does', () => {
  it('offer_refund makes one refund request, moves the case to refund_pending and replays from the key', async () => {
    const k = key();
    const body = { action: 'offer_refund', reason: 'goodwill refund' };
    const first = await act('cas_a', w.op, body, { idem: k });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { state: string }).state).toBe('refund_pending');
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM refund_requests WHERE unit_id = $1', [
        u['a']!.unit_id,
      ]),
    ).toBe(1);
    const again = await act('cas_a', w.op, body, { idem: k });
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(
      await count(w.app, 'SELECT count(*) AS c FROM refund_requests WHERE unit_id = $1', [
        u['a']!.unit_id,
      ]),
    ).toBe(1);
  });

  it('any action on a refund_pending or closed case is 409 wrong_state', async () => {
    for (const id of ['cas_a', 'cas_d']) {
      for (const action of [
        'diagnose',
        'restore',
        'credit',
        'close_not_charged',
        'offer_refund',
        'close_no_fault',
      ]) {
        const res = await act(id, w.op, { action, reason: 'try it', credit_ms: 1000 });
        expect(res.status, `${id} ${action}`).toBe(409);
        expect((await errorOf(res)).code).toBe('wrong_state');
      }
    }
    expect(await caseState('cas_d')).toBe('closed_no_fault');
  });

  it('diagnose and close_no_fault are journaled with the operator as the actor', async () => {
    expect((await act('cas_b', w.op, { action: 'diagnose', reason: 'look at it' })).status).toBe(
      200,
    );
    expect(await caseState('cas_b')).toBe('diagnosing');
    expect(
      (await act('cas_b', w.op, { action: 'close_no_fault', reason: 'nothing wrong found' }))
        .status,
    ).toBe(200);
    expect(await caseState('cas_b')).toBe('closed_no_fault');
    const acts = (
      await w.app.db.query<{ id: string; action: string; actor: string }>(
        "SELECT id, action, actor FROM recovery_actions WHERE case_id = 'cas_b' ORDER BY at, created_at, id",
      )
    ).rows;
    expect(acts.map((a) => [a.action, a.actor])).toEqual([
      ['diagnosed', 'operator:opr_vikram'],
      ['close_no_fault', 'operator:opr_vikram'],
    ]);
    for (const a of acts) {
      const t = (
        await w.app.db.query<{
          actor_kind: string;
          actor_id: string;
          channel: string;
          mfa: boolean;
        }>(
          "SELECT actor_kind, actor_id, channel, mfa FROM trace_events WHERE source_table = 'recovery_actions' AND source_id = $1",
          [a.id],
        )
      ).rows;
      expect(t).toEqual([
        { actor_kind: 'operator', actor_id: 'opr_vikram', channel: 'web', mfa: true },
      ]);
    }
  });

  it('an unknown case is 404 and an unknown action or a missing reason is refused', async () => {
    expect((await act('cas_none', w.op, { action: 'diagnose', reason: 'x1' })).status).toBe(404);
    expect([400, 422]).toContain(
      (await act('cas_c', w.op, { action: 'delete_everything', reason: 'x1' })).status,
    );
    expect([400, 422]).toContain((await act('cas_c', w.op, { action: 'close_no_fault' })).status);
    expect(await caseState('cas_c')).toBe('open');
  });

  it('close_not_charged on an order that holds a verified capture is 409, and the ledger guard still holds', async () => {
    const res = await act('cas_c', w.op, { action: 'close_not_charged', reason: 'not charged?' });
    expect(res.status).toBe(409);
    await expect(
      w.app.db.query(
        `INSERT INTO ledger_entries (id, unit_id, capture_id, kind, amount_minor, currency, refund_id, ref_entry_id, environment, created_at, updated_at)
         SELECT 'led_over', id, capture_id, 'refund', amount_minor * 3, 'USD', 'RF_OVER', NULL, 'dryrun', now(), now() FROM order_units WHERE id = $1`,
        [u['c']!.unit_id],
      ),
    ).rejects.toThrow();
  });
});
