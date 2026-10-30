// PUB-A2 adversarial (docs/specs/pub-a2-payee.md): the two payee routes under attack. A publisher can
// ask and never decide; an operator without the second factor is refused; CSRF, mass assignment, size
// and rate caps hold; no log line holds a whole merchant id.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorOf } from './refund-support';
import { bootPayeeWorld, postDecision, postRequest } from './payee-support';
import type { PayeeWebWorld } from './payee-support';

vi.mock('server-only', () => ({}));

let w: PayeeWebWorld;
beforeAll(async () => {
  w = await bootPayeeWorld();
});
afterAll(async () => {
  await w.app.close();
});
// Each case gets full rate buckets, so the 3 a day cap is only tested where it is the subject.
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const rows = async (sql: string, params: unknown[] = []) =>
  (await w.app.db.query<Record<string, unknown>>(sql, params)).rows;
const harbour = () => w.pub['harbour-ledger'];

describe('the decision route', () => {
  it('an operator without the second factor gets 403 mfa_required', async () => {
    const res = await postDecision(w, w.refund.demo, {
      request_id: 'prp_x',
      merchant_id_retyped: 'AAAAAAAAAAAAA',
      decision: 'verified',
      reason: 'Checked.',
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
  });

  it('a publisher session, a buyer session and no session cannot decide', async () => {
    const body = {
      request_id: 'prp_x',
      merchant_id_retyped: 'AAAAAAAAAAAAA',
      decision: 'verified',
      reason: 'Checked.',
    };
    expect((await postDecision(w, harbour(), body)).status).toBe(403);
    expect((await postDecision(w, w.refund.A, body)).status).toBe(403);
    expect((await postDecision(w, null, body)).status).toBe(401);
    expect(await rows('SELECT 1 FROM payee_decisions')).toHaveLength(0);
  });

  it('a missing CSRF token is 403 csrf', async () => {
    const res = await postDecision(
      w,
      w.refund.op,
      { request_id: 'prp_x', merchant_id_retyped: '', decision: 'rejected', reason: 'No.' },
      { csrf: false },
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('csrf');
  });

  it('mass assignment: a publisher_id or any extra field is refused by the strict shape', async () => {
    const res = await postDecision(w, w.refund.op, {
      request_id: 'prp_x',
      merchant_id_retyped: 'AAAAAAAAAAAAA',
      decision: 'verified',
      reason: 'Checked.',
      publisher_id: w.pubId['quayside-gazette'],
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('invalid_input');
  });

  it('a decision other than verified or rejected, or a short reason, is refused', async () => {
    for (const bad of [
      { decision: 'approved', reason: 'Checked.' },
      { decision: 'verified', reason: 'x' },
      { decision: 'verified', reason: 'y'.repeat(201) },
    ]) {
      const res = await postDecision(w, w.refund.op, {
        request_id: 'prp_x',
        merchant_id_retyped: 'AAAAAAAAAAAAA',
        ...bad,
      });
      expect(res.status).toBe(422);
    }
  });

  it('an oversized body is 413', async () => {
    const res = await postDecision(w, w.refund.op, {
      request_id: 'prp_x',
      merchant_id_retyped: '',
      decision: 'rejected',
      reason: 'z'.repeat(2000),
    });
    expect(res.status).toBe(413);
  });
});

describe('the request route', () => {
  it('a missing CSRF token is 403 csrf', async () => {
    const res = await postRequest(
      w,
      harbour(),
      { merchant_id: 'AAAAAAAAAAAAA', note: 'x' },
      { csrf: false },
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('csrf');
  });

  it('operators, buyers and anonymous callers cannot request', async () => {
    const body = { merchant_id: 'AAAAAAAAAAAAA', note: 'x' };
    expect((await postRequest(w, w.refund.op, body)).status).toBe(403);
    expect((await postRequest(w, w.refund.A, body)).status).toBe(403);
    expect((await postRequest(w, null, body)).status).toBe(401);
    expect(await rows('SELECT 1 FROM payee_change_requests')).toHaveLength(0);
  });

  it('mass assignment: publisher_id, payee_verified_at or paypal_merchant_id in the body is refused', async () => {
    for (const extra of [
      { publisher_id: w.pubId['quayside-gazette'] },
      { payee_verified_at: '2026-10-30T00:00:00.000Z' },
      { paypal_merchant_id: 'BBBBBBBBBBBBB' },
      { payee_shared: true },
    ]) {
      const res = await postRequest(w, harbour(), {
        merchant_id: 'AAAAAAAAAAAAA',
        note: 'x',
        ...extra,
      });
      expect(res.status).toBe(422);
    }
    expect(await rows('SELECT 1 FROM payee_change_requests')).toHaveLength(0);
  });

  it('a malformed merchant id is 422 and the request writes nothing', async () => {
    for (const bad of ['lower', 'aaaaaaaaaaaaa', 'AAAAAAAAAAAAAA', 'AAAAAAAAAAAA', 42, null]) {
      const res = await postRequest(w, harbour(), { merchant_id: bad, note: 'x' });
      expect(res.status).toBe(422);
    }
    expect(await rows('SELECT 1 FROM payee_change_requests')).toHaveLength(0);
  });

  it('a body over 1 KB is 413', async () => {
    const res = await postRequest(w, harbour(), { merchant_id: 'AAAAAAAAAAAAA', note: 'n'.repeat(2000) });
    expect(res.status).toBe(413);
  });

  it('the publisher cannot change its own payee by any route: the row is untouched', async () => {
    const before = await rows(
      'SELECT paypal_merchant_id, payee_verified_at, payee_shared FROM publishers WHERE id = $1',
      [w.pubId['harbour-ledger']],
    );
    const res = await postRequest(w, harbour(), { merchant_id: 'SNEAKYMERCH001', note: 'please' });
    expect(res.status).toBe(200);
    const after = await rows(
      'SELECT paypal_merchant_id, payee_verified_at, payee_shared FROM publishers WHERE id = $1',
      [w.pubId['harbour-ledger']],
    );
    expect(after).toEqual(before);
  });

  it('the 4th request in a day is 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await postRequest(w, w.pub['northfield-quarterly'], {
        merchant_id: `RATELIMIT00${String(i)}A`,
        note: 'x',
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describe('no whole merchant id outside the payee tables', () => {
  it('logs and audit rows hold the last 4 of a canary id only', async () => {
    const canary = 'CANARYMER9XYZ';
    const res = await postRequest(w, w.pub['quayside-gazette'], {
      merchant_id: canary,
      note: 'moving',
    });
    expect(res.status).toBe(200);
    const { request_id } = (await res.json()) as { request_id: string };
    // A refused attempt (typed wrong) and a verification.
    const wrong = await postDecision(w, w.refund.op, {
      request_id,
      merchant_id_retyped: 'CANARYMER9XYY',
      decision: 'verified',
      reason: 'Checked.',
    });
    expect(wrong.status).toBe(422);
    const good = await postDecision(w, w.refund.op, {
      request_id,
      merchant_id_retyped: canary,
      decision: 'verified',
      reason: 'Checked by phone.',
    });
    expect(good.status).toBe(200);
    // A malformed attempt that includes the canary in a rejected field.
    await postRequest(w, w.pub['quayside-gazette'], { merchant_id: `${canary}X`, note: canary });
    const audit = JSON.stringify(await rows('SELECT * FROM audit_log'));
    const log = w.logs.join('\n');
    for (const text of [audit, log]) {
      expect(text).not.toContain(canary);
      expect(text).not.toContain('CANARYMER9XYY');
    }
    expect(audit).toContain('9XYZ');
  });
});
