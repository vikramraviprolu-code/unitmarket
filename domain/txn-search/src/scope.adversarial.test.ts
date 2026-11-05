// INT-SR0 (SR0.2, size L): role rules. The check runs on the raw keys first, so a bad value never hides a
// refusal. Every principal kind in principal.ts is covered. Buyers and sellers are pinned to themselves, a
// seller never gets a buyer column or an order total, a `q` is matched as literal text, and a cursor never
// widens the scope. Runs on a real (PGlite) database with the standard world of test-fixtures.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, Principal } from '@umsbx/contracts';
import { parseTxnQuery } from '@umsbx/contracts';
import { TxnSearchError } from './cursor';
import { SELLER_COLUMNS, scopeQuery, searchTransactions } from './index';
import type { ScopedQuery } from './index';
import {
  NOW,
  openMigrated,
  seedArticle,
  seedBuyer,
  seedOrder,
  seedPublisher,
  seedStandardWorld,
} from './test-fixtures';
import type { Db } from './test-fixtures';

type P = Actor | Principal;

const BUYER: P = { kind: 'buyer', buyer_id: 'b1' };
const PUBLISHER: P = { kind: 'publisher', publisher_id: 'p1' };
const OPERATOR: P = { kind: 'operator', operator_id: 'op_1', mfa: true };
// What toActor() makes of an operator API key: an operator Actor without MFA.
const OPERATOR_NO_MFA: P = { kind: 'operator', operator_id: 'op_1', mfa: false };
const AGENT: P = { kind: 'agent', key_id: 'key_b2', buyer_id: 'b2', mandate_id: 'man_b2' };
const CLIENT_BUYER: P = {
  kind: 'api_client',
  key_id: 'key_c1',
  owner: { kind: 'buyer', buyer_id: 'b1' },
};
const CLIENT_PUBLISHER: P = {
  kind: 'api_client',
  key_id: 'key_c2',
  owner: { kind: 'publisher', publisher_id: 'p1' },
};
const CLIENT_OPERATOR: P = {
  kind: 'api_client',
  key_id: 'key_c3',
  owner: { kind: 'operator', operator_id: 'op_1', mfa: false },
};

const BUYER_REFUSED = ['buyer', 'environment', 'flags'];
const PUBLISHER_REFUSED = ['buyer', 'seller', 'agent_key', 'environment', 'flags'];

const go = (p: P, raw: Record<string, string>): ScopedQuery =>
  scopeQuery(p, raw, parseTxnQuery(raw));

let db: Db;
beforeAll(async () => {
  db = await openMigrated();
  await seedStandardWorld(db);
  // A mixed order: one order, two sellers, two provider orders. A seller must see its own unit only.
  await seedOrder(db, {
    id: 'o5',
    buyer: 'b1',
    created_at: '2026-11-04T11:00:00.000Z',
    status: 'paid',
    provider_orders: [
      { id: 'po_o5_1', provider_order_id: 'PAYPALMIX001', publisher: 'p1' },
      { id: 'po_o5_2', provider_order_id: 'PAYPALMIX002', publisher: 'p2' },
    ],
    units: [
      {
        id: 'u5a',
        publisher: 'p1',
        amount_minor: 150,
        status: 'captured_verified',
        articles: ['a1'],
      },
      {
        id: 'u5b',
        publisher: 'p2',
        amount_minor: 250,
        status: 'captured_verified',
        articles: ['a2'],
      },
    ],
  });
  // Titles with characters that mean something to LIKE or to SQL.
  await seedBuyer(db, 'b3', 'Cy Buyer');
  await seedPublisher(db, 'p3', 'odd', 'Odd Titles');
  const odd: Array<[string, string]> = [
    ['a_pct', '100% Pure'],
    ['a_und', 'snake_case'],
    ['a_bsl', 'back\\slash'],
    ['a_inj', "Tom' OR 1=1 -- Tales"],
    ['a_plain', 'Plain Words'],
  ];
  for (const [id, title] of odd) await seedArticle(db, id, 'p3', title);
  for (const [i, [id]] of odd.entries()) {
    await seedOrder(db, {
      id: `ox${i}`,
      buyer: 'b3',
      created_at: `2026-10-0${i + 1}T10:00:00.000Z`,
      status: 'paid',
      units: [
        {
          id: `ux${i}`,
          publisher: 'p3',
          amount_minor: 10,
          status: 'captured_verified',
          articles: [id],
        },
      ],
    });
  }
});
afterAll(() => db.close());

const units = async (p: P, raw: Record<string, string>): Promise<string[]> => {
  const page = await searchTransactions(db, go(p, raw), { now: NOW, h: 'h1' });
  return page.rows.map((r) => String(r['unit_id']));
};

describe('refusals run on the raw keys (SR0.2)', () => {
  const VALUES = ['x', '', 'bogus', '1'];
  const cases: Array<[string, P, string[]]> = [
    ['buyer session', BUYER, BUYER_REFUSED],
    ['agent key', AGENT, BUYER_REFUSED],
    ['api_client of a buyer', CLIENT_BUYER, BUYER_REFUSED],
    ['publisher session', PUBLISHER, PUBLISHER_REFUSED],
    ['api_client of a publisher', CLIENT_PUBLISHER, PUBLISHER_REFUSED],
  ];
  for (const [label, principal, refused] of cases) {
    for (const field of refused) {
      for (const value of VALUES) {
        it(`${label}: ${field}=${JSON.stringify(value)} is 400 field_not_allowed`, () => {
          let caught: unknown;
          try {
            go(principal, { [field]: value });
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(TxnSearchError);
          const e = caught as TxnSearchError;
          expect(e.status).toBe(400);
          expect(e.code).toBe('field_not_allowed');
          expect(refused).toContain(e.field);
        });
      }
    }
  }

  it('an invalid value does not hide the refusal (environment=bogus, flags=bogus)', () => {
    for (const p of [BUYER, AGENT, CLIENT_BUYER, PUBLISHER, CLIENT_PUBLISHER]) {
      expect(() => go(p, { environment: 'bogus' }), 'environment').toThrow(TxnSearchError);
      expect(() => go(p, { flags: 'bogus' }), 'flags').toThrow(TxnSearchError);
    }
  });

  it('the key is matched without regard to case', () => {
    expect(() => go(BUYER, { BUYER: 'b2' })).toThrow(TxnSearchError);
    expect(() => go(PUBLISHER, { Seller: 'p2' })).toThrow(TxnSearchError);
  });

  it('an inherited property is not a key', () => {
    const raw = Object.create({ buyer: 'b2' }) as Record<string, string>;
    expect(parseTxnQuery(raw)).toEqual({});
    expect(() => scopeQuery(BUYER, raw, parseTxnQuery(raw))).not.toThrow();
  });

  it('operators are refused nothing', () => {
    for (const p of [OPERATOR, CLIENT_OPERATOR]) {
      expect(() =>
        go(p, { buyer: 'b1', seller: 'p1', environment: 'dryrun', flags: 'alert', agent_key: 'k' }),
      ).not.toThrow();
    }
  });

  it('a system actor has no search access', () => {
    let caught: unknown;
    try {
      go({ kind: 'system' }, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxnSearchError);
    expect((caught as TxnSearchError).status).toBe(403);
  });
});

describe('pins (SR0.2)', () => {
  it('a buyer session sees its own lines only', async () => {
    expect((await units(BUYER, {})).sort()).toEqual(['u1', 'u2', 'u5a', 'u5b']);
  });
  it('a buyer cannot reach another buyer through a reference', async () => {
    expect(await units(BUYER, { ref: 'ref_o3' })).toEqual([]);
    expect(await units(BUYER, { ref: 'ref_o1' })).toEqual(['u1']);
  });
  it("a buyer's foreign agent_key gives zero rows (the key filter is ANDed with the pin)", async () => {
    expect(await units(BUYER, { agent_key: 'key_b2' })).toEqual([]);
    expect(await units(BUYER, { channel: 'agent' })).toEqual([]);
  });
  it('an agent key sees the lines of its buyer, and no one else', async () => {
    expect((await units(AGENT, {})).sort()).toEqual(['u3', 'u4']);
    expect(await units(AGENT, { agent_key: 'key_b2' })).toEqual(['u3']);
    expect(await units(AGENT, { agent_key: 'key_other' })).toEqual([]);
  });
  it('an api_client of a buyer acts as that buyer; of a publisher as that publisher', async () => {
    expect((await units(CLIENT_BUYER, {})).sort()).toEqual(['u1', 'u2', 'u5a', 'u5b']);
    expect((await units(CLIENT_PUBLISHER, {})).sort()).toEqual(['u1', 'u3', 'u5a']);
  });
  it('a publisher session sees its own lines only, including its part of a mixed order', async () => {
    expect((await units(PUBLISHER, {})).sort()).toEqual(['u1', 'u3', 'u5a']);
    expect(await units(PUBLISHER, { ref: 'ref_o2' })).toEqual([]);
  });
  it('an unknown principal kind is refused rather than treated as an operator', () => {
    const odd = { kind: 'robot' } as unknown as P;
    expect(() => scopeQuery(odd, {}, {})).toThrow(TxnSearchError);
  });
});

describe('sellers never get buyer columns (SR0.2)', () => {
  it('seller rows have exactly the seller columns', async () => {
    const page = await searchTransactions(db, go(PUBLISHER, {}), { now: NOW, h: 'h1' });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows)
      expect(Object.keys(row).sort()).toEqual([...SELLER_COLUMNS].sort());
  });
  it('the seller columns leave out buyer_id, buyer_display_name, agent_key_id, mandate_id and order_total_minor', () => {
    for (const hidden of [
      'buyer_id',
      'buyer_display_name',
      'agent_key_id',
      'mandate_id',
      'order_total_minor',
    ])
      expect(SELLER_COLUMNS).not.toContain(hidden);
  });
  it('a seller cannot learn the buyer through text or reference filters either', async () => {
    // "Ada Buyer" is a buyer name; a seller's q only reads item titles.
    expect(await units(PUBLISHER, { q: 'ada' })).toEqual([]);
    const page = await searchTransactions(db, go(PUBLISHER, { q: 'harbour' }), {
      now: NOW,
      h: 'h1',
    });
    expect(JSON.stringify(page.rows)).not.toMatch(/Ada Buyer|Bo Buyer|"b1"|"b2"/);
  });
  it('a buyer sees its own columns, but never the seller-only secrets of others', async () => {
    const page = await searchTransactions(db, go(BUYER, {}), { now: NOW, h: 'h1' });
    for (const row of page.rows) expect(row['buyer_id']).toBe('b1');
  });
});

describe('operator keys and sessions (SR0.2)', () => {
  it('an operator session may match a buyer by display name', async () => {
    expect((await units(OPERATOR, { buyer: 'Ada Buyer' })).sort()).toEqual([
      'u1',
      'u2',
      'u5a',
      'u5b',
    ]);
    expect((await units(OPERATOR, { buyer: 'ada' })).sort()).toEqual(['u1', 'u2', 'u5a', 'u5b']);
    expect((await units(OPERATOR, { buyer: 'b2' })).sort()).toEqual(['u3', 'u4']);
  });
  it("an operator key's buyer=<name> matches nothing, but buyer=<id> works", async () => {
    expect(await units(CLIENT_OPERATOR, { buyer: 'Ada Buyer' })).toEqual([]);
    expect(await units(CLIENT_OPERATOR, { buyer: 'ada' })).toEqual([]);
    expect((await units(CLIENT_OPERATOR, { buyer: 'b2' })).sort()).toEqual(['u3', 'u4']);
  });
  it("an operator key's seller=<name> matches nothing, but seller=<id> works", async () => {
    expect(await units(CLIENT_OPERATOR, { seller: 'Harbour Markets' })).toEqual([]);
    expect(await units(CLIENT_OPERATOR, { seller: 'harbour' })).toEqual([]);
    expect((await units(CLIENT_OPERATOR, { seller: 'p1' })).sort()).toEqual(['u1', 'u3', 'u5a']);
  });
  it('an operator Actor without MFA (an operator API key through toActor) matches buyer and seller by id only', async () => {
    expect(await units(OPERATOR_NO_MFA, { buyer: 'Ada Buyer' })).toEqual([]);
    expect(await units(OPERATOR_NO_MFA, { buyer: 'ada' })).toEqual([]);
    expect((await units(OPERATOR_NO_MFA, { buyer: 'b2' })).sort()).toEqual(['u3', 'u4']);
    expect(await units(OPERATOR_NO_MFA, { seller: 'Harbour Markets' })).toEqual([]);
    expect(await units(OPERATOR_NO_MFA, { seller: 'harbour' })).toEqual([]);
    expect((await units(OPERATOR_NO_MFA, { seller: 'p1' })).sort()).toEqual(['u1', 'u3', 'u5a']);
  });
  it('an operator sees every environment and may filter on flags', async () => {
    expect((await units(OPERATOR, { environment: 'dryrun' })).length).toBeGreaterThan(5);
    expect(await units(OPERATOR, { environment: 'sandbox' })).toEqual([]);
    expect(await units(OPERATOR, { flags: 'alert' })).toEqual([]);
  });
});

describe('q is literal text, never a pattern or SQL (SR0.2)', () => {
  it('a single backslash matches only the title that holds one', async () => {
    expect(await units(OPERATOR, { q: '\\' })).toEqual(['ux2']);
  });
  it('a percent sign matches only the title that holds one', async () => {
    expect(await units(OPERATOR, { q: '%' })).toEqual(['ux0']);
  });
  it('an underscore matches only the title that holds one', async () => {
    expect(await units(OPERATOR, { q: '_' })).toEqual(['ux1']);
  });
  it("' OR 1=1 -- matches only the title that spells it out", async () => {
    expect(await units(OPERATOR, { q: "' OR 1=1 --" })).toEqual(['ux3']);
    expect(await units(OPERATOR, { q: "x' OR '1'='1" })).toEqual([]);
  });
  it('the match is case-insensitive and by substring', async () => {
    expect(await units(OPERATOR, { q: 'plain WORDS' })).toEqual(['ux4']);
    expect(await units(OPERATOR, { q: 'wor' })).toEqual(['ux4']);
  });
  it('injection text in every other text field returns no rows and no error', async () => {
    const evil = "'; DROP TABLE orders; --";
    for (const field of ['buyer', 'seller', 'ref', 'agent_key']) {
      expect(await units(OPERATOR, { [field]: evil }), field).toEqual([]);
    }
    // The tables are still there.
    expect((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0]).toEqual({ n: 10 });
  });
});

describe('a cursor cannot widen the scope (SR0.2)', () => {
  it("carries no buyer or seller, and b2 cannot use b1's cursor to read b1's lines", async () => {
    const first = await searchTransactions(db, go(BUYER, { limit: '1' }), { now: NOW, h: 'h1' });
    expect(first.rows).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const text = Buffer.from(first.next_cursor!, 'base64url').toString('utf8');
    expect(text).not.toMatch(/b1|p1|buyer|publisher/);
    // The same cursor, same query hash, another buyer: still only b2's own lines come back.
    const other = await searchTransactions(
      db,
      go(AGENT, { cursor: first.next_cursor!, limit: '10' }),
      { now: NOW, h: 'h1' },
    );
    for (const row of other.rows) expect(row['buyer_id']).toBe('b2');
  });
  it('a cursor made for one query hash is refused for another', async () => {
    const first = await searchTransactions(db, go(BUYER, { limit: '1' }), { now: NOW, h: 'h1' });
    await expect(
      searchTransactions(db, go(BUYER, { cursor: first.next_cursor!, limit: '1' }), {
        now: NOW,
        h: 'other',
      }),
    ).rejects.toMatchObject({ code: 'bad_cursor', status: 400 });
  });
  it('a tampered cursor is refused, not turned into page 1', async () => {
    await expect(
      searchTransactions(db, go(BUYER, { cursor: 'AAAA', limit: '1' }), { now: NOW, h: 'h1' }),
    ).rejects.toMatchObject({ code: 'bad_cursor' });
  });
});
