// INT-GA / GA.2 (F6, F14): the model fallback. Personal data never leaves: emails, order refs (the `ord_` id and
// the display form), PayPal id shapes, long digit runs and "buyer <Name>" / "seller <Name>" phrases are taken out
// before anything else, placed as a local chip when the role allows it and dropped otherwise. The port sees only
// the scrubbed rest. Its answer then passes four checks in order: a string map or nothing; refused keys for the
// role removed and listed; invalid values dropped; the scope check last, which can no longer refuse.
import { describe, expect, it, vi } from 'vitest';
import { REFUSED_FIELDS, parseTxnQuery } from '@umsbx/contracts';
import type { ModelPort, ModelRequest, ModelResponse } from '@umsbx/contracts';
import { assistQuery, parseRules, parseWithModel } from './index';
import type { AssistContext, AssistRole } from './index';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const SELLERS = ['Harbour Ledger', 'Quayside Gazette'];
const ctx = (role: AssistRole, sellers = SELLERS): AssistContext => ({ role, sellers });

/** A port that records every request and answers with `output`. */
function spyPort(output: unknown = {}): { port: ModelPort; seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  const port: ModelPort = {
    model_id: 'spy',
    async complete(r: ModelRequest): Promise<ModelResponse> {
      seen.push(structuredClone(r));
      return { kind: 'ok', output, input_tokens: 0, output_tokens: 0 };
    },
  };
  return { port, seen };
}

const EMAIL = 'alice@example.com';
const ORDER_REF = 'ord_7x2q9abcdefgh';
const CAPTURE = '3C679366HH908993F';
const DIGITS = '1234567';

describe('personal data is taken out before the model sees anything', () => {
  const text = `stuck orders for ${EMAIL} ${ORDER_REF} capture ${CAPTURE} card ${DIGITS} buyer Alice Smith with money back`;

  it.each(['buyer', 'publisher', 'operator'] as const)(
    'as %s: the request holds only the scrubbed rest',
    async (role) => {
      const { port, seen } = spyPort({});
      await assistQuery(text, NOW, ctx(role), port);
      expect(seen).toHaveLength(1);
      const sent = JSON.stringify(seen[0]);
      for (const secret of [
        EMAIL,
        ORDER_REF,
        CAPTURE,
        DIGITS,
        'Alice',
        'Smith',
        'alice',
        'example.com',
      ])
        expect(sent).not.toContain(secret);
      expect(seen[0]!.purpose).toBe('txn_query');
      expect(Object.keys(seen[0]!.input as object)).toEqual(['rest']);
      const rest = (seen[0]!.input as { rest: string }).rest;
      expect(rest).toContain('stuck');
      expect(rest).toContain('money back');
    },
  );

  it('the display ref form (an ellipsis and six characters) is a ref too', () => {
    const r = parseRules('where is …X9ABCD', NOW, ctx('buyer'));
    expect(r.rest).not.toContain('X9ABCD');
    expect(r.chips).toEqual({ ref: 'X9ABCD' });
  });

  it('an operator gets the email as a buyer chip and the ref as a ref chip', () => {
    const r = parseRules(`${EMAIL} ${ORDER_REF}`, NOW, ctx('operator'));
    expect(r.chips).toEqual({ buyer: EMAIL, ref: ORDER_REF });
    expect(r.dropped).toEqual([]);
  });

  it('an operator gets a PayPal id as a ref chip', () => {
    expect(parseRules(`capture ${CAPTURE}`, NOW, ctx('operator')).chips).toEqual({ ref: CAPTURE });
  });

  it('an operator gets "buyer Alice Smith" as a buyer chip', () => {
    expect(parseRules('buyer Alice Smith', NOW, ctx('operator')).chips).toEqual({
      buyer: 'Alice Smith',
    });
  });

  it('a buyer gets an order ref as a ref chip, and the email and the PayPal id are dropped', () => {
    const r = parseRules(`${ORDER_REF} ${EMAIL} ${CAPTURE}`, NOW, ctx('buyer'));
    expect(r.chips).toEqual({ ref: ORDER_REF });
    expect(r.dropped).toEqual(['buyer', 'ref']);
    expect(r.rest).toBe('');
  });

  it('a long digit run is never placed and never kept, for any role', () => {
    for (const role of ['buyer', 'publisher', 'operator'] as const) {
      const r = parseRules(`orders ${DIGITS}`, NOW, ctx(role));
      expect(r.chips).toEqual({});
      expect(r.dropped).toEqual(['number']);
      expect(r.rest).toBe('');
    }
  });

  it('a lower case "buyer alice smith\'s" phrase is taken out too', () => {
    const r = parseRules("show buyer alice smith's orders", NOW, ctx('buyer'));
    expect(r.rest).toBe('');
    expect(r.dropped).toEqual(['buyer']);
  });
});

describe('"Show buyer X\'s orders" from a buyer', () => {
  it('gives chips scoped to self with buyer in dropped, and the scope check never sees a refused key', async () => {
    const { port } = spyPort({ buyer: 'Xavier Quill' });
    const scope = vi.fn((raw: Record<string, string>) => {
      for (const f of REFUSED_FIELDS.buyer) expect(Object.keys(raw)).not.toContain(f);
    });
    const r = await assistQuery("Show buyer Xavier Quill's orders", NOW, ctx('buyer'), port, scope);
    expect(r.chips).toEqual({});
    expect(r.dropped).toContain('buyer');
    expect(scope).toHaveBeenCalledTimes(1);
  });
});

describe('the four checks on the model answer, in order', () => {
  it.each([
    ['an array', ['status', 'paid']],
    ['a string', 'status=paid'],
    ['null', null],
    ['a number value', { status: 'paid', min_minor: 5 }],
    ['a nested value', { status: { any: 'paid' } }],
  ])('1. %s is dropped whole', async (_n, output) => {
    const { port } = spyPort(output);
    const r = await parseWithModel('stuck', port, ctx('operator'));
    expect(r.chips).toEqual({});
  });

  it('1. an error answer or a throw is nothing, never a crash', async () => {
    const err: ModelPort = {
      model_id: 'e',
      complete: async () => ({ kind: 'error', reason: 'x' }),
    };
    const boom: ModelPort = {
      model_id: 'b',
      complete: async () => {
        throw new Error('down');
      },
    };
    expect((await parseWithModel('stuck', err, ctx('buyer'))).chips).toEqual({});
    expect((await parseWithModel('stuck', boom, ctx('buyer'))).chips).toEqual({});
  });

  it('2. a seller never gets buyer, seller or agent_key chips, and they are listed as dropped', async () => {
    const { port } = spyPort({ buyer: 'b', agent_key: 'k', seller: 's', status: 'paid' });
    const r = await parseWithModel('anything', port, ctx('publisher'));
    expect(r.chips).toEqual({ status: 'paid' });
    expect(r.dropped.sort()).toEqual(['agent_key', 'buyer', 'seller']);
  });

  it('2. a buyer never gets buyer, environment or flags chips', async () => {
    const { port } = spyPort({ buyer: 'b', environment: 'sandbox', flags: 'alert', case: 'open' });
    const r = await parseWithModel('anything', port, ctx('buyer'));
    expect(r.chips).toEqual({ case: 'open' });
    expect(r.dropped.sort()).toEqual(['buyer', 'environment', 'flags']);
  });

  it('3. invalid values are dropped; valid ones keep their string form', async () => {
    const { port } = spyPort({
      status: 'bogus',
      from: '2026-13-01',
      channel: 'agent',
      min_minor: '250',
    });
    const r = await parseWithModel('anything', port, ctx('operator'));
    expect(r.chips).toEqual({ channel: 'agent', min_minor: '250' });
    expect(r.dropped.sort()).toEqual(['from', 'status']);
  });

  it('3. keys that are not filters (and the page cursor and size) are ignored', async () => {
    const { port } = spyPort({ drop_table: 'x', cursor: 'abc', limit: '100', sort: 'amount' });
    const r = await parseWithModel('anything', port, ctx('operator'));
    expect(r.chips).toEqual({ sort: 'amount' });
    expect(r.dropped).toEqual([]);
  });

  it('4. the scope check runs last with chips that parse, and so cannot refuse', async () => {
    const { port } = spyPort({ buyer: 'b', status: 'paid' });
    const scope = vi.fn((raw: Record<string, string>, parsed: unknown) => {
      expect(raw).toEqual({ status: 'paid' });
      expect(parsed).toEqual(parseTxnQuery(raw));
    });
    await parseWithModel('anything', port, ctx('buyer'), scope);
    expect(scope).toHaveBeenCalledTimes(1);
  });

  it('a rule chip wins over a model chip for the same field', async () => {
    const { port } = spyPort({ status: 'failed', channel: 'agent' });
    const r = await assistQuery('paid orders by my agent', NOW, ctx('buyer'), port);
    expect(r.chips).toEqual({ status: 'paid', channel: 'agent' });
  });

  it('an empty rest asks nothing', async () => {
    const { port, seen } = spyPort({ status: 'paid' });
    expect((await parseWithModel('   ', port, ctx('buyer'))).chips).toEqual({});
    expect(seen).toHaveLength(0);
  });
});
