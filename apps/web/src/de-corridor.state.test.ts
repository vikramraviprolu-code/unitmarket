// MC2-L2 (docs/specs/mc2-l2-de-eur-corridor.md): the German corridor and publisher at boot. Outside
// NODE_ENV=test the step runs on every boot, after the Quayside supplement; in tests it is off unless
// asked for (`test_seed.de_corridor: true`), so the counts of the older tests hold. Dry run only: no
// PayPal, no socket, synthetic owner id.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootPackApp, OWNER_ID } from './composite-support';

vi.mock('server-only', () => ({}));

const DE_SLUG = 'rheinwerft-kurier';
const count = async (a: App, sql: string, p: unknown[] = []): Promise<number> =>
  Number((await a.db.query<{ c: string | number }>(sql, p)).rows[0]!.c);
const deRows = async (a: App) => ({
  corridor: (
    await a.db.query<{ enabled: boolean; currency: string }>(
      `SELECT enabled, currency FROM corridors WHERE id = 'de-eur'`,
    )
  ).rows,
  publishers: await count(a, `SELECT count(*) AS c FROM publishers WHERE slug = $1`, [DE_SLUG]),
  articles: await count(
    a,
    `SELECT count(*) AS c FROM articles x JOIN publishers p ON p.id = x.publisher_id WHERE p.slug = $1`,
    [DE_SLUG],
  ),
  offers: await count(
    a,
    `SELECT count(*) AS c FROM offers o JOIN publishers p ON p.id = o.publisher_id WHERE p.slug = $1 AND o.currency = 'EUR' AND o.status = 'authorised'`,
    [DE_SLUG],
  ),
});
const sandbox = (dir: string, own: string): Record<string, string> => ({
  UMS_MODE: 'sandbox',
  UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-25-test',
  PAYPAL_CLIENT_ID: 'synthetic-client-id-for-tests',
  PAYPAL_CLIENT_SECRET: 'synthetic-client-secret-for-tests-xyz',
  UMS_OWN_MERCHANT_ID: own,
  UMS_DB: 'pglite-disk',
  UMS_PGLITE_DIR: dir,
});

describe('boot seeding of the German corridor (MC2-L2)', () => {
  it('tests do not get it unless they ask: the older counts hold', async () => {
    const app = await bootPackApp();
    try {
      expect((await deRows(app)).publishers).toBe(0);
      expect((await deRows(app)).corridor).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a disk that holds the old seed gets de-eur (off), the publisher and three offers; later boots add nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc2l2-disk-'));
    try {
      const env = { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: join(dir, 'db') };
      const old = await bootPackApp(env);
      const oldCounts = {
        publishers: await count(old, 'SELECT count(*) AS c FROM publishers'),
        offers: await count(old, 'SELECT count(*) AS c FROM offers'),
        corridors: await count(old, 'SELECT count(*) AS c FROM corridors'),
      };
      expect(oldCounts.corridors).toBe(2);
      await old.close();
      const again = await bootPackApp(env, { test_seed: { de_corridor: true } });
      expect(await deRows(again)).toEqual({
        corridor: [{ enabled: false, currency: 'EUR' }],
        publishers: 1,
        articles: 3,
        offers: 3,
      });
      expect(await count(again, 'SELECT count(*) AS c FROM publishers')).toBe(
        oldCounts.publishers + 1,
      );
      expect(await count(again, 'SELECT count(*) AS c FROM offers')).toBe(oldCounts.offers + 3);
      expect(await count(again, 'SELECT count(*) AS c FROM corridors')).toBe(3);
      await again.close();
      const third = await bootPackApp(env, { test_seed: { de_corridor: true } });
      expect((await deRows(third)).offers).toBe(3);
      expect(await count(third, 'SELECT count(*) AS c FROM publishers')).toBe(
        oldCounts.publishers + 1,
      );
      expect(await count(third, 'SELECT count(*) AS c FROM offers')).toBe(oldCounts.offers + 3);
      // Offline: the German publisher gets its own dry-run payee, not shared.
      const p = await third.db.query<{ paypal_merchant_id: string; payee_shared: boolean }>(
        `SELECT paypal_merchant_id, payee_shared FROM publishers WHERE slug = $1`,
        [DE_SLUG],
      );
      expect(p.rows[0]!.paypal_merchant_id).toMatch(/^DRYRUN/);
      expect(p.rows[0]!.payee_shared).toBe(false);
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sandbox mode: the German publisher is paid into the owner account, shared, audited once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc2l2-sbx-'));
    try {
      const env = sandbox(join(dir, 'db'), OWNER_ID);
      const first = await bootPackApp(env, { test_seed: { de_corridor: true } });
      const rows = async (a: App) =>
        (
          await a.db.query<{
            slug: string;
            paypal_merchant_id: string | null;
            payee_shared: boolean;
            payee_verified_at: unknown;
          }>(
            'SELECT slug, paypal_merchant_id, payee_shared, payee_verified_at FROM publishers ORDER BY slug',
          )
        ).rows;
      const r1 = await rows(first);
      const de = r1.find((r) => r.slug === DE_SLUG)!;
      expect(de.paypal_merchant_id).toBe(OWNER_ID);
      expect(de.payee_shared).toBe(true);
      expect(de.payee_verified_at).not.toBeNull();
      // Harbour, Quayside and the German publisher share the owner id, all flagged; Northfield is not covered.
      for (const s of ['harbour-ledger', 'quayside-gazette', DE_SLUG]) {
        const r = r1.find((x) => x.slug === s)!;
        expect([s, r.paypal_merchant_id, r.payee_shared]).toEqual([s, OWNER_ID, true]);
      }
      const audits = (a: App) =>
        count(a, `SELECT count(*) AS c FROM audit_log WHERE action LIKE 'seed.payee%'`);
      expect(await audits(first)).toBe(3);
      const ops = await first.engine.opsSnapshot({
        kind: 'operator',
        operator_id: 'opr_demo',
        mfa: false,
      });
      expect(ops?.shared_payee).toEqual({ publishers: 3, last4: OWNER_ID.slice(-4) });
      await first.close();
      const second = await bootPackApp(env, { test_seed: { de_corridor: true } });
      expect(await rows(second)).toEqual(r1);
      expect(await audits(second)).toBe(3);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sandbox mode on an old disk (Quayside already shared, no German rows): the German publisher is added and flagged, the others stay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc2l2-sbx2-'));
    try {
      const env = sandbox(join(dir, 'db'), OWNER_ID);
      const old = await bootPackApp(env);
      const before = (
        await old.db.query(
          'SELECT slug, paypal_merchant_id, payee_shared FROM publishers ORDER BY slug',
        )
      ).rows;
      await old.close();
      const now = await bootPackApp(env, { test_seed: { de_corridor: true } });
      const after = (
        await now.db.query(
          'SELECT slug, paypal_merchant_id, payee_shared FROM publishers ORDER BY slug',
        )
      ).rows;
      for (const r of before) expect(after).toContainEqual(r);
      expect(after).toContainEqual({
        slug: DE_SLUG,
        paypal_merchant_id: OWNER_ID,
        payee_shared: true,
      });
      await now.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a US buyer and the German EUR offer', () => {
  // MC2-L1 removed the buyer-country gate (docs/specs/mc2-l1-buyer-country-gate.md): a US buyer may buy a German offer.
  it('with de-eur enabled, a US buyer is quoted and can be approved the EUR offer (MC2-L1)', async () => {
    const app = await bootPackApp({}, { test_seed: { de_corridor: true } });
    try {
      await app.db.query(`UPDATE corridors SET enabled = true WHERE id = 'de-eur'`);
      const buyer = (
        await app.db.query<{ id: string }>(
          `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
        )
      ).rows[0]!;
      const actor: Actor = { kind: 'buyer', buyer_id: buyer.id };
      const q = await app.engine.quote({
        offer: { publisher_slug: DE_SLUG, offer_code: 'schleusenzeiten' },
        actor,
        source: 'direct',
        option: 'online_read',
      });
      if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote: ${JSON.stringify(q)}`);
      expect(q.value).toMatchObject({
        corridor_id: 'de-eur',
        price: { currency: 'EUR', minor: 120 },
      });
      const g = await app.engine.requestApproval({
        actor,
        selection: { kind: 'quote', quote_id: q.value.quote_id },
        consent: { terms: true, identity_share: false },
      });
      expect(g.ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});
