// INT-GA / GA.2 through the real route and the real app: POST /api/assist/query. The model port of the app
// (App.model) sees only the scrubbed rest: no email, no seeded order ref, no PayPal id shape, no long digit run,
// no "buyer <Name>" phrase, and none of the seed's buyer names or the amounts typed. Model output that is not a
// string map is dropped. A buyer asking for another buyer gets chips scoped to self with `buyer` dropped; a seller
// never gets buyer or agent_key chips; no answer is ever a field_not_allowed refusal. With ai_enabled off the
// scripted answer is used. An operator without the second factor gets 403; the 21st call in a minute gets 429. The
// text, the chips and the answer appear in no log line.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ModelResponse } from '@umsbx/contracts';
import { bootA } from './api-v1/a-support';
import type { ARig, Sess } from './api-v1/a-support';
import { HARBOUR_TIDE, runPack } from './composite-support';
import { call } from './support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const lines: string[] = [];
let rig: ARig;
let route: typeof import('./app/api/assist/query/route');
let buyer: Sess;
let seller: Sess;
let op: Sess;
let noMfa: Sess;
let orderRef = '';
let buyerNames: string[] = [];
let captureIds: string[] = [];

beforeAll(async () => {
  rig = await bootA({}, { log_sink: (l: string) => void lines.push(l) });
  route = await import('./app/api/assist/query/route');
  buyer = await rig.session(rig.buyerA);
  seller = await rig.session(rig.harbour);
  op = await rig.session({ kind: 'operator', operator_id: 'opr_vikram', mfa: true });
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_demo', mfa: false });
  const started = await runPack(rig.app, rig.buyerA, [HARBOUR_TIDE], ['happy']);
  orderRef = started.order_ref;
  buyerNames = (
    await rig.app.db.query<{ n: string }>('SELECT display_name AS n FROM buyers')
  ).rows.map((r) => r.n);
  captureIds = (
    await rig.app.db.query<{ c: string }>(
      'SELECT capture_id AS c FROM order_units WHERE capture_id IS NOT NULL',
    )
  ).rows.map((r) => r.c);
});
afterAll(async () => rig?.app.close());

const ask = (s: Sess | null, text: unknown) =>
  call(route.POST, { url: '/api/assist/query', method: 'POST', session: s, body: { text } });
interface Answer {
  chips: Record<string, string>;
  dropped: string[];
}
const answer = async (s: Sess, text: string): Promise<Answer> => {
  const r = await ask(s, text);
  expect(r.status).toBe(200);
  return (await r.json()) as Answer;
};

describe('the port request holds only the scrubbed rest', () => {
  it('there is a seeded order, a capture id and buyer names to hide', () => {
    expect(orderRef).toMatch(/^ord_/);
    expect(captureIds.length).toBeGreaterThan(0);
    expect(buyerNames.length).toBeGreaterThan(0);
  });

  it('no email, ref, PayPal id, digit run, buyer phrase, seed name or typed amount reaches the model', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete');
    const name = buyerNames[0]!;
    const text = `stuck orders over $4.20 for alice@example.com ${orderRef} capture ${captureIds[0]} 1234567 buyer ${name} buyer Alice Smith money back`;
    for (const s of [buyer, seller, op]) await answer(s, text);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [req] of spy.mock.calls as [ModelRequest][]) {
      const sent = JSON.stringify(req);
      for (const secret of [
        'alice@example.com',
        orderRef,
        captureIds[0]!,
        '1234567',
        'Alice',
        'Smith',
        ...name.split(/\s+/).filter((w) => w.length > 2),
        '4.20',
        '420',
      ])
        expect(sent, secret).not.toContain(secret);
      expect(req.purpose).toBe('txn_query');
      expect(Object.keys(req.input as object)).toEqual(['rest']);
    }
    spy.mockRestore();
  });

  it('model output that is not a string map is dropped whole', async () => {
    const spy = vi
      .spyOn(rig.app.model, 'complete')
      .mockResolvedValue({ kind: 'ok', output: ['status', 'paid'], input_tokens: 0, output_tokens: 0 });
    expect((await answer(op, 'stuck')).chips).toEqual({});
    spy.mockResolvedValue({ kind: 'ok', output: { status: 7 }, input_tokens: 0, output_tokens: 0 } as ModelResponse);
    expect((await answer(op, 'stuck')).chips).toEqual({});
    spy.mockRestore();
  });
});

describe('role scope', () => {
  it('"Show buyer X\'s orders" from a buyer: chips scoped to self, buyer dropped, never a 400', async () => {
    const spy = vi
      .spyOn(rig.app.model, 'complete')
      .mockResolvedValue({ kind: 'ok', output: { buyer: 'Xavier Quill' }, input_tokens: 0, output_tokens: 0 });
    const r = await ask(buyer, "Show buyer Xavier Quill's orders");
    expect(r.status).toBe(200);
    const a = (await r.json()) as Answer;
    expect(a.chips).toEqual({});
    expect(a.dropped).toContain('buyer');
    spy.mockRestore();
  });

  it('a seller never gets buyer or agent_key chips, even when the model offers them', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete').mockResolvedValue({
      kind: 'ok',
      output: { buyer: 'b', agent_key: 'k', seller: 's', status: 'paid' },
      input_tokens: 0,
      output_tokens: 0,
    });
    const a = await answer(seller, 'my sales by somebody');
    expect(Object.keys(a.chips)).not.toContain('buyer');
    expect(Object.keys(a.chips)).not.toContain('agent_key');
    expect(Object.keys(a.chips)).not.toContain('seller');
    expect(a.chips).toEqual({ status: 'paid' });
    spy.mockRestore();
  });
});

describe('the switches and the wrapper', () => {
  it('with ai_enabled off the scripted answer is used and nothing refuses', async () => {
    await rig.app.db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'ai_enabled'`);
    const a = await answer(buyer, 'stuck orders by my agent');
    expect(a.chips).toEqual({ status: 'attention', channel: 'agent' });
    await rig.app.db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'ai_enabled'`);
  });

  it('an operator without the second factor gets 403 mfa_required', async () => {
    const r = await ask(noMfa, 'stuck');
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
  });

  it('no session is 401; a text over 500 characters or not a string is 422', async () => {
    expect((await ask(null, 'stuck')).status).toBe(401);
    expect((await ask(buyer, 'x'.repeat(501))).status).toBe(422);
    expect((await ask(buyer, 42)).status).toBe(422);
  });

  it('the 21st call in a minute gets 429', async () => {
    const fresh = await rig.session(rig.buyerB);
    const codes: number[] = [];
    for (let i = 0; i < 21; i += 1) codes.push((await ask(fresh, `paid orders ${i % 2 === 0 ? 'today' : 'yesterday'}`)).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('the text, the chips and the answer appear in no log line', async () => {
    const marker = 'zebracanaryword';
    const spy = vi.spyOn(rig.app.model, 'complete').mockResolvedValue({
      kind: 'ok',
      output: { q: 'giraffecanaryanswer' },
      input_tokens: 0,
      output_tokens: 0,
    });
    await answer(op, `${marker} orders`);
    spy.mockRestore();
    const all = lines.join('\n');
    expect(all).not.toContain(marker);
    expect(all).not.toContain('giraffecanaryanswer');
    expect(all).not.toContain('alice@example.com');
  });
});
