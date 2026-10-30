// PUB-E1: the refunds, since and csv modules obey the same isolation rules as sales and statement. The
// publisher id is the actor's and is the only bound parameter; a probe with extra arguments changes nothing;
// the sources read no request, touch no buyer data and never write.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@umsbx/contracts';
import { refundsFor } from './refunds';
import { countsSince } from './since';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
let B_REF = '';
const A = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const B = { kind: 'publisher', publisher_id: 'pub_2' } as const;
const SINCE = '2000-01-01T00:00:00.000Z';
type Loose = (...a: unknown[]) => Promise<unknown>;

beforeAll(async () => {
  w = await makeWorld();
  const a = await w.unit({ n: 1, publisher: 'pub_1', status: 'refunded', title: 'A article' });
  await w.ledger(a.unit_id, a.capture_id!, 'sale', 500);
  await w.ledger(a.unit_id, a.capture_id!, 'refund', 500, { refund_id: 'rf_a' });
  const b = await w.unit({
    n: 2,
    publisher: 'pub_2',
    status: 'refunded',
    title: 'B article',
    buyer: 'buy_2',
  });
  await w.ledger(b.unit_id, b.capture_id!, 'sale', 777);
  await w.ledger(b.unit_id, b.capture_id!, 'refund', 777, { refund_id: 'rf_b' });
  B_REF = b.order_ref;
});
afterAll(async () => {
  await w.close();
});

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

describe('A never sees B in the new read models', () => {
  it('refunds: nothing of B, also when B order ref and id are passed as extra arguments', async () => {
    const plain = await refundsFor(w.db, A);
    const probed = await (refundsFor as unknown as Loose)(w.db, A, B_REF, B.publisher_id);
    expect(probed).toEqual(plain);
    const text = JSON.stringify(plain);
    expect(text).not.toContain('B article');
    expect(text).not.toContain(B_REF.slice(-6));
    expect(plain).toHaveLength(1);
  });
  it('since: counts only A rows, also with extra arguments', async () => {
    const plain = await countsSince(w.db, A, SINCE);
    const probed = await (countsSince as unknown as Loose)(w.db, A, SINCE, B.publisher_id);
    expect(probed).toEqual(plain);
    expect(plain).toMatchObject({ new_sales: 1, refunds: 1 });
  });
});

describe('no query takes a client supplied id', () => {
  it('every statement binds the actor publisher id (and the instant for since) and nothing else', async () => {
    for (const actor of [A, B]) {
      const r = recorded(w.db);
      await (refundsFor as unknown as Loose)(r.db, actor, B_REF, 'x');
      for (const c of r.calls) expect(c.params, c.sql).toEqual([actor.publisher_id]);
      const s = recorded(w.db);
      await (countsSince as unknown as Loose)(s.db, actor, SINCE, B_REF);
      expect(s.calls.length).toBeGreaterThan(0);
      for (const c of s.calls) expect(c.params, c.sql).toEqual([actor.publisher_id, SINCE]);
    }
  });
  it('the sources read no request, touch no buyer data and never write', () => {
    for (const f of ['refunds.ts', 'since.ts', 'csv.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, f).not.toMatch(/searchParams|request|params\.|cookies|headers/);
      expect(src, f).not.toMatch(/buyer|auth_subject|display_name|email/i);
      expect(src, f).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    }
  });
});
