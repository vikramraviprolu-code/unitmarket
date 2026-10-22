import { afterEach, describe, expect, it } from 'vitest';
import type { Result } from '@umsbx/contracts';
import { markUsed, requestApproval, verifyApproval } from './index';
import {
  BUYER_A,
  BUYER_B,
  CONSENT,
  addQuote,
  makeHarness,
  realIds,
  type Harness,
} from './test-fixtures';

let h: Harness;
afterEach(async () => {
  await h.db.close();
});
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
const quote = { kind: 'quote', quote_id: 'quo_1' } as const;
async function granted(opts: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(opts);
  await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
  return value(
    await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
  );
}
const verify = (
  g: { approval_id: string },
  token: string,
  actor: typeof BUYER_A | typeof BUYER_B = BUYER_A,
) => verifyApproval(h.db, h.deps, { approval_id: g.approval_id, token, actor });

describe('token', () => {
  it('tampered token 403', async () => {
    const g = await granted();
    const [id, hex] = g.token.split('.') as [string, string];
    const flipped = hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');
    const bad = [
      `${id}.${flipped}`,
      `${id}.${hex.toUpperCase()}`,
      `${id}.`,
      id,
      '',
      `${id}.${hex}.${hex}`,
      `apr_other.${hex}`,
      `${id}.${'0'.repeat(64)}`,
    ];
    for (const token of bad) {
      expect(await verify(g, token)).toEqual({
        ok: false,
        error: { code: 'bad_token', http: 403 },
      });
    }
    expect((await verify(g, g.token)).ok).toBe(true);
  });

  it('a token signed with another secret 403', async () => {
    const other = await granted({ approvalSecret: '3'.repeat(32) });
    await h.db.close();
    const g = await granted();
    expect(await verify(g, other.token.replace(other.approval_id, g.approval_id))).toEqual({
      ok: false,
      error: { code: 'bad_token', http: 403 },
    });
  });

  it('a token cannot be moved to another approval of the same buyer', async () => {
    const g = await granted();
    const second = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
    const moved = `${second.approval_id}.${g.token.split('.')[1]}`;
    expect(await verify(second, moved)).toEqual({
      ok: false,
      error: { code: 'bad_token', http: 403 },
    });
  });
});

describe('stored snapshot', () => {
  async function editRow(sql: string, params: unknown[] = []) {
    // Test-only: the immutability trigger is bypassed to simulate an attacker with DB write access.
    await h.db.exec('ALTER TABLE approvals DISABLE TRIGGER approvals_guard');
    await h.db.query(sql, params);
    await h.db.exec('ALTER TABLE approvals ENABLE TRIGGER approvals_guard');
  }

  it('snapshot row edited in DB gives snapshot_tampered 403 (P5)', async () => {
    const g = await granted();
    const edited = structuredClone(g.snapshot);
    edited.items[0]!.amount_minor = 1;
    edited.publishers[0]!.amount_minor = 1;
    edited.total_minor = 1;
    await editRow('UPDATE approvals SET snapshot = $1::jsonb WHERE id = $2', [
      JSON.stringify(edited),
      g.approval_id,
    ]);
    expect(await verify(g, g.token)).toEqual({
      ok: false,
      error: { code: 'snapshot_tampered', http: 403 },
    });
  });

  it('payee swapped in DB gives snapshot_tampered 403', async () => {
    const g = await granted();
    const edited = structuredClone(g.snapshot);
    edited.items[0]!.payee_merchant_id = 'ATTACKER';
    edited.publishers[0]!.payee_merchant_id = 'ATTACKER';
    await editRow('UPDATE approvals SET snapshot = $1::jsonb WHERE id = $2', [
      JSON.stringify(edited),
      g.approval_id,
    ]);
    expect(await verify(g, g.token)).toEqual({
      ok: false,
      error: { code: 'snapshot_tampered', http: 403 },
    });
  });

  it('a snapshot that is no longer valid for its schema is snapshot_tampered, not a crash', async () => {
    const g = await granted();
    await editRow(`UPDATE approvals SET snapshot = '{"x":1}'::jsonb WHERE id = $1`, [
      g.approval_id,
    ]);
    expect(await verify(g, g.token)).toEqual({
      ok: false,
      error: { code: 'snapshot_tampered', http: 403 },
    });
  });

  it('snapshot and hash both rewritten in DB: the token (bound to the hash) fails 403', async () => {
    const g = await granted();
    const { contentHash } = await import('./index');
    const edited = structuredClone(g.snapshot);
    edited.items[0]!.amount_minor = 1;
    edited.publishers[0]!.amount_minor = 1;
    edited.total_minor = 1;
    await editRow('UPDATE approvals SET snapshot = $1::jsonb, content_hash = $2 WHERE id = $3', [
      JSON.stringify(edited),
      contentHash(edited),
      g.approval_id,
    ]);
    expect(await verify(g, g.token)).toEqual({
      ok: false,
      error: { code: 'bad_token', http: 403 },
    });
  });

  it('expires_at pushed out in DB: the token (bound to expires_at) fails 403', async () => {
    const g = await granted();
    await editRow(`UPDATE approvals SET expires_at = '2027-01-01T00:00:00Z' WHERE id = $1`, [
      g.approval_id,
    ]);
    const r = await verify(g, g.token);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toMatch(/^(bad_token|snapshot_tampered)$/);
  });

  it('the database itself refuses to edit an approval snapshot', async () => {
    const g = await granted();
    await expect(
      h.db.query(`UPDATE approvals SET snapshot = '{}'::jsonb WHERE id = $1`, [g.approval_id]),
    ).rejects.toThrow();
  });
});

describe('single use and ownership', () => {
  it('reused approval 409 (P10)', async () => {
    const g = await granted();
    expect((await verify(g, g.token)).ok).toBe(true);
    expect((await markUsed(h.db, h.deps, { approval_id: g.approval_id })).ok).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      expect(await verify(g, g.token)).toEqual({
        ok: false,
        error: { code: 'already_used', http: 409 },
      });
    }
  });

  it('two concurrent markUsed: exactly one wins', async () => {
    const g = await granted();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => markUsed(h.db, h.deps, { approval_id: g.approval_id })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(4);
  });

  it("buyer B with buyer A's approval gives 404", async () => {
    const g = await granted();
    expect(await verify(g, g.token, BUYER_B)).toEqual({
      ok: false,
      error: { code: 'not_owner', http: 404 },
    });
  });

  it('non-buyer actors get 404 as well', async () => {
    const g = await granted();
    for (const actor of [
      { kind: 'system' },
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'operator', operator_id: 'opr_1', mfa: true },
    ] as const) {
      expect(
        await verifyApproval(h.db, h.deps, { approval_id: g.approval_id, token: g.token, actor }),
      ).toEqual({ ok: false, error: { code: 'not_owner', http: 404 } });
    }
  });

  it('expired is reported before used', async () => {
    const g = await granted();
    await markUsed(h.db, h.deps, { approval_id: g.approval_id });
    h.clock.advance(15 * 60_000);
    expect(await verify(g, g.token)).toEqual({ ok: false, error: { code: 'expired', http: 410 } });
  });
});

describe('nonce', () => {
  it('nonces unique over 10k and not sequential', async () => {
    h = await makeHarness({ ids: realIds() });
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const nonces: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const g = value(
        await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
      );
      expect(g.approval_id).toBeTruthy();
    }
    const rows = await h.db.query<{ nonce: string }>(
      'SELECT nonce FROM approvals ORDER BY created_at, id',
    );
    for (const r of rows.rows) nonces.push(r.nonce);
    expect(nonces).toHaveLength(10_000);
    expect(new Set(nonces).size).toBe(10_000);
    for (const n of nonces) expect(n).toMatch(/^[a-f0-9]{32}$/);
    // Not sequential: the high 48 bits of consecutive draws never step by a small amount.
    const hi = nonces.map((n) => BigInt(`0x${n.slice(0, 12)}`));
    let close = 0;
    for (let i = 1; i < hi.length; i += 1) {
      const d = hi[i]! > hi[i - 1]! ? hi[i]! - hi[i - 1]! : hi[i - 1]! - hi[i]!;
      if (d < 1_000_000n) close += 1;
    }
    expect(close).toBeLessThan(5);
    // Roughly half the bits set over the whole sample.
    const ones = nonces.reduce(
      (n, s) =>
        n + [...s].reduce((m, c) => m + parseInt(c, 16).toString(2).replace(/0/g, '').length, 0),
      0,
    );
    expect(ones / (10_000 * 128)).toBeGreaterThan(0.48);
    expect(ones / (10_000 * 128)).toBeLessThan(0.52);
  }, 240_000);
});
