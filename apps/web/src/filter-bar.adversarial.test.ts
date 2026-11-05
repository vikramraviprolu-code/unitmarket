// INT-OPS-B / OPS-B.1 (B1): the bar and the server share one refused-field table. For each role the offered
// fields are the full set minus its REFUSED_FIELDS entry, and for every field and role that agrees with
// scopeQuery: a refused field gives a 400 field_not_allowed, an offered field does not. A URL that carries a
// refused field loses it in the bar and never sends it.
import { describe, expect, it, vi } from 'vitest';
import { REFUSED_FIELDS, parseTxnQuery } from '@umsbx/contracts';
import type { Actor, Principal } from '@umsbx/contracts';
import { TxnSearchError, scopeQuery } from '../composition.server';
import {
  ACTIVITY_FIELDS,
  TXN_FIELDS,
  barState,
  offeredFields,
  parseQueryString,
  queryString,
  txnPersona,
  withField,
} from './lib/filter-bar-view';
import type { FilterPersona } from './lib/filter-bar-view';

vi.mock('server-only', () => ({}));

const PERSONAS = Object.keys(REFUSED_FIELDS) as FilterPersona[];

const PRINCIPAL: Record<FilterPersona, Actor | Principal> = {
  buyer: { kind: 'buyer', buyer_id: 'buy_1' },
  agent: { kind: 'agent', key_id: 'key_1', buyer_id: 'buy_1', mandate_id: null },
  publisher: { kind: 'publisher', publisher_id: 'pub_1' },
  operator_key: { kind: 'operator', operator_id: 'opr_1', mfa: false },
  operator: { kind: 'operator', operator_id: 'opr_1', mfa: true },
};

const refusedBy = (p: FilterPersona, field: string): boolean => {
  try {
    scopeQuery(PRINCIPAL[p], { [field]: 'x' }, parseTxnQuery({ [field]: 'x' }));
    return false;
  } catch (e) {
    if (e instanceof TxnSearchError && e.code === 'field_not_allowed' && e.status === 400)
      return true;
    throw e;
  }
};

describe('OPS-B.1 refused fields (B1)', () => {
  it.each(PERSONAS)('%s is offered the full set minus its REFUSED_FIELDS entry', (persona) => {
    const offered = offeredFields({ kind: 'txn', persona });
    expect([...offered]).toEqual(TXN_FIELDS.filter((f) => !REFUSED_FIELDS[persona].includes(f)));
  });

  it('a seller is never offered buyer, seller, agent_key, environment or flags', () => {
    const offered = offeredFields({ kind: 'txn', persona: 'publisher' });
    for (const f of ['buyer', 'seller', 'agent_key', 'environment', 'flags'])
      expect(offered).not.toContain(f);
  });

  it.each(PERSONAS)(
    'for every field, %s: refused by the bar exactly when scopeQuery refuses',
    (persona) => {
      const offered = offeredFields({ kind: 'txn', persona });
      for (const field of TXN_FIELDS) {
        const refused = refusedBy(persona, field);
        expect(offered.includes(field), `${persona} ${field}`).toBe(!refused);
      }
    },
  );

  it('maps a signed-in actor to the role the server will apply', () => {
    expect(txnPersona({ kind: 'operator', mfa: true })).toBe('operator');
    expect(txnPersona({ kind: 'operator', mfa: false })).toBe('operator_key');
    expect(txnPersona({ kind: 'publisher' })).toBe('publisher');
    expect(txnPersona({ kind: 'buyer' })).toBe('buyer');
  });

  it('a URL with refused fields loses them and never sends them', () => {
    const url =
      'buyer=Wes&seller=Quay&agent_key=k1&environment=sandbox&flags=alert&Buyer=x&status=paid';
    const state = barState({ kind: 'txn', persona: 'publisher' }, parseQueryString(url));
    expect(queryString(state.map)).toBe('status=paid');
    expect(state.chips.map((c) => c.field)).toEqual(['status']);
    // And what it sends is accepted by the server for that role.
    expect(() =>
      scopeQuery(PRINCIPAL.publisher, state.map, parseTxnQuery(state.map)),
    ).not.toThrow();
  });

  it('adding a refused field changes nothing', () => {
    const ctx = { kind: 'txn', persona: 'buyer' } as const;
    for (const f of REFUSED_FIELDS.buyer)
      expect(queryString(withField(ctx, { status: 'paid' }, f, 'x'))).toBe('status=paid');
  });

  it('whatever URL arrives, what the bar sends is never refused for the role', () => {
    const noisy = parseQueryString(
      TXN_FIELDS.map((f) => `${f}=x`).join('&') + '&view=sandbox_only&sort=amount',
    );
    for (const persona of PERSONAS) {
      const state = barState({ kind: 'txn', persona }, noisy);
      expect(() =>
        scopeQuery(PRINCIPAL[persona], state.map, parseTxnQuery(state.map)),
      ).not.toThrow();
    }
  });
});

describe('OPS-B.4 the Activity bar without the second factor (B5)', () => {
  it('does not offer actor_id, so the page never triggers the 403', () => {
    expect([...offeredFields({ kind: 'activity', mfa: false })]).toEqual(
      ACTIVITY_FIELDS.filter((f) => f !== 'actor_id'),
    );
    expect([...offeredFields({ kind: 'activity', mfa: true })]).toEqual([...ACTIVITY_FIELDS]);
  });

  it('drops an actor_id from the URL and from what it sends', () => {
    const ctx = { kind: 'activity', mfa: false } as const;
    const state = barState(ctx, parseQueryString('actor_id=opr_vikram&channel=web'));
    expect(queryString(state.map)).toBe('channel=web');
    expect(queryString(withField(ctx, {}, 'actor_id', 'opr_vikram'))).toBe('');
  });
});

describe('OPS-B.1 hostile URLs', () => {
  const ctx = { kind: 'txn', persona: 'operator' } as const;
  it('ignores prototype keys, unknown keys, control characters and very long values', () => {
    const raw = parseQueryString(
      `__proto__=x&constructor=y&toString=z&nope=1&q=${encodeURIComponent('a\u0000b')}&ref=${'r'.repeat(500)}&status=paid`,
    );
    const state = barState(ctx, raw);
    expect(queryString(state.map)).toBe('status=paid');
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('keeps a value that looks like markup as text, encoded', () => {
    const state = barState(
      ctx,
      parseQueryString(`q=${encodeURIComponent('<script>alert(1)</script>')}`),
    );
    expect(queryString(state.map)).toBe('q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(state.chips[0]!.text).toBe('Search: <script>alert(1)</script>');
  });

  it('keeps only the first of a repeated key and survives a malformed escape', () => {
    expect(queryString(barState(ctx, parseQueryString('status=paid&status=failed')).map)).toBe(
      'status=paid',
    );
    expect(() => parseQueryString('q=%E0%A4%A&status=paid')).not.toThrow();
    expect(queryString(barState(ctx, parseQueryString('q=%E0%A4%A&status=paid')).map)).toContain(
      'status=paid',
    );
  });
});
