// PUB-A2 adversarial tests: who may ask, who may decide, what leaks. Money path: who gets paid.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { decidePayeeRequest, listOpenRequests, payeeView, requestPayeeChange } from './index';
import {
  MERCH_CANARY,
  MERCH_NEW,
  MERCH_OLD,
  MERCH_OTHER,
  count,
  payeeWorld,
  publisherRow,
} from './payee-support';
import type { PayeeWorld } from './payee-support';

let w: PayeeWorld;
beforeAll(async () => {
  w = await payeeWorld();
});
afterAll(async () => {
  await w.db.close();
});

const ask = async (actor: Actor, merchant_id: string) => {
  const r = await requestPayeeChange(w.deps('dryrun'), actor, { merchant_id, note: 'please' });
  if (!r.ok) throw new Error(`request refused: ${r.error.code}`);
  return r.value.request_id;
};

const verify = (actor: Actor, request_id: string, typed: string, env: 'dryrun' | 'sandbox' = 'dryrun') =>
  decidePayeeRequest(w.deps(env), actor, {
    request_id,
    merchant_id_retyped: typed,
    decision: 'verified',
    reason: 'Checked.',
  });

describe('who may ask', () => {
  it('a buyer, an operator, the system and no one cannot request a payee change', async () => {
    for (const actor of [w.buyer, w.opMfa, { kind: 'system' } as Actor]) {
      const r = await requestPayeeChange(w.deps('dryrun'), actor, {
        merchant_id: MERCH_NEW,
        note: 'x',
      });
      expect(r).toEqual({ ok: false, error: { code: 'not_publisher' } });
    }
    expect(await count(w.db, 'SELECT count(*) AS c FROM payee_change_requests')).toBe(0);
  });

  it('a publisher id that names no row cannot request', async () => {
    const r = await requestPayeeChange(
      w.deps('dryrun'),
      { kind: 'publisher', publisher_id: 'pub_ghost' },
      { merchant_id: MERCH_NEW, note: 'x' },
    );
    expect(r.ok).toBe(false);
    expect(await count(w.db, 'SELECT count(*) AS c FROM payee_change_requests')).toBe(0);
  });
});

describe('who may decide', () => {
  it('a publisher cannot verify, not even its own request, and nothing changes', async () => {
    const id = await ask(w.actorA, MERCH_NEW);
    const before = await publisherRow(w.db, w.pubA);
    for (const actor of [w.actorA, w.actorB, w.actorC]) {
      const r = await verify(actor, id, MERCH_NEW);
      expect(r).toEqual({ ok: false, error: { code: 'not_operator' } });
    }
    expect(await publisherRow(w.db, w.pubA)).toEqual(before);
    expect(
      await count(w.db, 'SELECT count(*) AS c FROM payee_decisions WHERE request_id = $1', [id]),
    ).toBe(0);
  });

  it('a publisher cannot reject either', async () => {
    const id = await ask(w.actorA, 'REJECTBYPUB01');
    const r = await decidePayeeRequest(w.deps('dryrun'), w.actorA, {
      request_id: id,
      merchant_id_retyped: '',
      decision: 'rejected',
      reason: 'No.',
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_operator' } });
  });

  it('a buyer, the system and an operator without the second factor cannot decide', async () => {
    const id = await ask(w.actorA, 'NOTANOPERATOR1');
    const cases: [Actor, string][] = [
      [w.buyer, 'not_operator'],
      [{ kind: 'system' }, 'not_operator'],
      [w.opNoMfa, 'mfa_required'],
    ];
    for (const [actor, code] of cases) {
      expect(await verify(actor, id, 'NOTANOPERATOR1')).toEqual({ ok: false, error: { code } });
    }
    expect(
      await count(w.db, 'SELECT count(*) AS c FROM payee_decisions WHERE request_id = $1', [id]),
    ).toBe(0);
  });
});

describe('what a publisher can see', () => {
  it('never sees another publisher request or history, and cannot list the open queue', async () => {
    const idA = await ask(w.actorA, 'ONLYAPUBLISH01');
    const viewB = (await payeeView(w.db, w.actorB))!;
    expect(viewB.history.map((h) => h.request_id)).not.toContain(idA);
    expect(JSON.stringify(viewB)).not.toContain('ONLYAPUBLISH01');
    for (const actor of [w.actorA, w.actorB, w.buyer, w.opNoMfa]) {
      const r = await listOpenRequests(w.db, actor);
      expect(r.ok).toBe(false);
    }
  });
});

describe('duplicate merchant ids', () => {
  it('verifying an id another unflagged publisher holds is refused as merchant_in_use', async () => {
    const id = await ask(w.actorA, MERCH_OTHER);
    const before = await publisherRow(w.db, w.pubA);
    const decisions = await count(w.db, 'SELECT count(*) AS c FROM payee_decisions');
    const r = await verify(w.opMfa, id, MERCH_OTHER);
    expect(r).toEqual({ ok: false, error: { code: 'merchant_in_use' } });
    expect(await publisherRow(w.db, w.pubA)).toEqual(before);
    expect(await count(w.db, 'SELECT count(*) AS c FROM payee_decisions')).toBe(decisions);
    // The request is still open: the operator may reject it.
    const open = await listOpenRequests(w.db, w.opMfa);
    expect(open.ok && open.value.some((x) => x.request_id === id)).toBe(true);
  });
});

describe('only the last 4 is ever recorded outside the two payee tables', () => {
  it('audit rows and the log hold the last 4 of a canary id, never the whole id', async () => {
    const lines: string[] = [];
    const id = await ask(w.actorB, MERCH_CANARY);
    w.clock.advance(1000);
    const okR = await verify(w.opMfa, id, MERCH_CANARY);
    expect(okR.ok).toBe(true);
    // A refused attempt too (typed wrong), and a sandbox refusal on a second request.
    const id2 = await ask(w.actorB, 'CANARYTWO0000');
    await verify(w.opMfa, id2, 'CANARYTWO0001');
    await verify(w.opMfa, id2, 'CANARYTWO0000', 'sandbox');
    const audit = await w.db.query<Record<string, unknown>>('SELECT * FROM audit_log');
    const text = JSON.stringify(audit.rows) + lines.join('\n') + w.logs.join('\n');
    for (const secret of [MERCH_CANARY, 'CANARYTWO0000', 'CANARYTWO0001', MERCH_OLD, MERCH_OTHER]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(MERCH_CANARY.slice(-4));
    // The two payee tables and publishers hold the id; nothing else does.
    const pub = await publisherRow(w.db, w.pubB);
    expect(pub.paypal_merchant_id).toBe(MERCH_CANARY);
  });

  it('the view and the open list expose the last 4 only', async () => {
    const v = JSON.stringify(await payeeView(w.db, w.actorB));
    expect(v).not.toContain(MERCH_CANARY);
    expect(v).toContain(MERCH_CANARY.slice(-4));
    const open = JSON.stringify(await listOpenRequests(w.db, w.opMfa));
    expect(open).not.toContain('CANARYTWO0000');
  });
});

describe('input shape', () => {
  it('a note longer than 200 characters or empty is refused; a mass id is not an input', async () => {
    const long = await requestPayeeChange(w.deps('dryrun'), w.actorA, {
      merchant_id: 'LONGNOTE00001',
      note: 'x'.repeat(201),
    });
    expect(long).toEqual({ ok: false, error: { code: 'invalid_input' } });
    const empty = await requestPayeeChange(w.deps('dryrun'), w.actorA, {
      merchant_id: 'EMPTYNOTE0001',
      note: '   ',
    });
    expect(empty).toEqual({ ok: false, error: { code: 'invalid_input' } });
  });
});
