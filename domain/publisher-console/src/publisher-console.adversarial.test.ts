// PUB-C: a publisher sees only its own units and ledger rows. The id of the publisher comes from the
// actor and from nowhere else: every query is recorded and may carry no parameter but that id.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@umsbx/contracts';
import { salesFor } from './sales';
import { statementFor } from './statement';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
let B_REF = '';
const A = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const B = { kind: 'publisher', publisher_id: 'pub_2' } as const;
const CTX = { own_merchant_id: null, environment: 'dryrun' } as const;

beforeAll(async () => {
  w = await makeWorld();
  const a = await w.unit({ n: 1, publisher: 'pub_1', title: 'A article' });
  await w.ledger(a.unit_id, a.capture_id!, 'sale', 500);
  const b = await w.unit({ n: 2, publisher: 'pub_2', title: 'B article', buyer: 'buy_2' });
  await w.ledger(b.unit_id, b.capture_id!, 'sale', 777);
  B_REF = b.order_ref;
});
afterAll(async () => {
  await w.close();
});

/** The database, with every statement and its parameters written down. */
function recorded(db: SqlExecutor): {
  db: SqlExecutor;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    db: {
      query: ((sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return db.query(sql, params);
      }) as SqlExecutor['query'],
      exec: (sql: string) => db.exec(sql),
    },
  };
}

describe('A never sees B', () => {
  it('sales: no unit, title, amount or order ref of B, also when B order ref is passed as an extra argument', async () => {
    const plain = await salesFor(w.db, A);
    const probed = await (salesFor as unknown as (...a: unknown[]) => Promise<unknown>)(
      w.db,
      A,
      B_REF,
      B.publisher_id,
    );
    expect(probed).toEqual(plain);
    const text = JSON.stringify(plain);
    expect(text).not.toContain('B article');
    expect(text).not.toContain(B_REF.slice(-6));
    expect(plain).toHaveLength(1);
  });

  it('statement: no ledger row of B, also when B order ref is passed as an extra argument', async () => {
    const plain = await statementFor(w.db, A, CTX);
    const probed = await (statementFor as unknown as (...a: unknown[]) => Promise<unknown>)(
      w.db,
      A,
      CTX,
      B_REF,
      B.publisher_id,
    );
    expect(probed).toEqual(plain);
    expect(JSON.stringify(plain)).not.toContain(B_REF.slice(-6));
    expect(plain.blocks[0]?.sales_minor).toBe(500);
  });

  it('an actor that is not a publisher gets nothing', async () => {
    const buyer = { kind: 'buyer', buyer_id: 'buy_1' } as never;
    expect(await salesFor(w.db, buyer)).toEqual([]);
    expect((await statementFor(w.db, buyer, CTX)).blocks).toEqual([]);
    const operator = { kind: 'operator', operator_id: 'opr_x', mfa: true } as never;
    expect(await salesFor(w.db, operator)).toEqual([]);
  });
});

describe('no query takes a client supplied id', () => {
  it('every statement of both read models binds the actor publisher id and nothing else', async () => {
    for (const actor of [A, B]) {
      const r = recorded(w.db);
      await (salesFor as unknown as (...a: unknown[]) => Promise<unknown>)(r.db, actor, B_REF, 'x');
      await (statementFor as unknown as (...a: unknown[]) => Promise<unknown>)(
        r.db,
        actor,
        CTX,
        B_REF,
        'x',
      );
      expect(r.calls.length).toBeGreaterThan(0);
      for (const c of r.calls) {
        expect(c.params, c.sql).toEqual([actor.publisher_id]);
        expect(c.sql, c.sql).toMatch(/publisher_id = \$1|\bid = \$1/);
      }
    }
  });

  it('the sources read no request, take no id parameter and never touch buyer data', () => {
    const dir = new URL('.', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => /^(sales|statement|settlement)\.ts$/.test(x))) {
      const src = readFileSync(new URL(f, dir), 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, f).not.toMatch(/searchParams|request|params\.|cookies|headers/);
      expect(src, f).not.toMatch(/buyer|auth_subject|display_name|email/i);
      expect(src, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    }
  });
});
