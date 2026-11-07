// POB-DEMOLINK (docs/specs/web-demo-paypal-links.md): in dry run the boot seed gives each demo publisher a clearly
// synthetic verified PayPal link, so the offline demo can show a payout. Sandbox mode creates none. In tests the step is
// off unless asked for (`test_seed.demo_links: true`), so older tests that insert their own link keep working.
// Dry run and the in-process database only: no PayPal, no socket. Addresses are fictional.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { bootPackApp } from './composite-support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = Date.parse('2026-11-06T09:00:00.000Z');
const DAY = 86_400_000;
const DEMO = ['harbour-ledger', 'northfield-quarterly', 'quayside-gazette', 'rheinwerft-kurier'];
const SEED = { demo_links: true, de_corridor: true } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface LinkRow {
  slug: string;
  publisher_id: string;
  paypal_email: string;
  state: string;
  verified_by: string | null;
  verified_at: Date | null;
  created_at: Date;
}
const links = async (a: App): Promise<LinkRow[]> =>
  (
    await a.db.query<LinkRow>(
      `SELECT p.slug, l.publisher_id, l.paypal_email, l.state, l.verified_by, l.verified_at, l.created_at
         FROM publisher_paypal_links l JOIN publishers p ON p.id = l.publisher_id ORDER BY p.slug`,
    )
  ).rows;
const count = async (a: App, sql: string): Promise<number> =>
  Number((await a.db.query<{ c: string | number }>(sql)).rows[0]!.c);
const auditRows = (a: App) =>
  count(a, "SELECT count(*) AS c FROM audit_log WHERE action = 'seed.paypal_link_synthetic'");

describe('dry run boot', () => {
  it('every demo publisher gets exactly one synthetic verified link: .invalid, unique, marked, stamped with the clock', async () => {
    const app = await bootPackApp({}, { test_seed: SEED });
    try {
      const rows = await links(app);
      expect(rows.map((r) => r.slug)).toEqual(DEMO);
      expect(await count(app, 'SELECT count(*) AS c FROM publishers')).toBe(DEMO.length);
      for (const r of rows) {
        expect(r.paypal_email).toBe(`demo-${r.slug}@payee.invalid`);
        expect(r).toMatchObject({ state: 'verified', verified_by: 'seed:synthetic' });
        expect(r.verified_at!.toISOString()).toBe(new Date(NOW).toISOString());
      }
      expect(new Set(rows.map((r) => r.paypal_email)).size).toBe(rows.length);
      expect(await auditRows(app)).toBe(DEMO.length);
      // the audit rows carry the masked address only
      const audit = JSON.stringify(
        (await app.db.query("SELECT * FROM audit_log WHERE action = 'seed.paypal_link_synthetic'"))
          .rows,
      );
      expect(audit).not.toContain('demo-harbour-ledger@');
    } finally {
      await app.close();
    }
  });

  it('tests do not get the links unless they ask for them', async () => {
    const app = await bootPackApp();
    try {
      expect(await links(app)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('seeding again is idempotent, and a link that exists in any state is never touched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demolink-disk-'));
    try {
      const env = { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: join(dir, 'db') };
      const first = await bootPackApp(env, { test_seed: SEED });
      const before = await links(first);
      expect(before).toHaveLength(DEMO.length);
      // a publisher replaced the address of one demo publisher; an operator has not checked it yet
      await first.db.query(
        `UPDATE publisher_paypal_links SET paypal_email = 'moved@example.test', state = 'requested',
                verified_by = NULL, verified_at = NULL
          WHERE publisher_id = (SELECT id FROM publishers WHERE slug = 'quayside-gazette')`,
      );
      const replaced = await links(first);
      await first.close();
      vi.setSystemTime(NOW + 3 * DAY);
      for (let i = 0; i < 2; i++) {
        const again = await bootPackApp(env, { test_seed: SEED });
        expect(await links(again)).toEqual(replaced);
        expect(await auditRows(again)).toBe(DEMO.length);
        await again.close();
      }
      expect(replaced.find((r) => r.slug === 'quayside-gazette')).toMatchObject({
        paypal_email: 'moved@example.test',
        state: 'requested',
      });
      expect(replaced.filter((r) => r.slug !== 'quayside-gazette')).toEqual(
        before.filter((r) => r.slug !== 'quayside-gazette'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sandbox mode boot', () => {
  it('creates no link, even when the test asks for the step, and still sets the shared payees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demolink-sbx-'));
    try {
      const app = await bootPackApp(
        {
          UMS_MODE: 'sandbox',
          UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-25-test',
          PAYPAL_CLIENT_ID: 'synthetic-client-id-for-tests',
          PAYPAL_CLIENT_SECRET: 'synthetic-client-secret-for-tests-xyz',
          UMS_OWN_MERCHANT_ID: 'SYNOWNER00001',
          UMS_DB: 'pglite-disk',
          UMS_PGLITE_DIR: join(dir, 'db'),
        },
        { test_seed: SEED },
      );
      try {
        expect(await links(app)).toEqual([]);
        expect(await count(app, 'SELECT count(*) AS c FROM publisher_paypal_links')).toBe(0);
        expect(await auditRows(app)).toBe(0);
        // the sandbox seed ran as before
        expect(await count(app, 'SELECT count(*) AS c FROM publishers WHERE payee_shared')).toBe(3);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a dry run sale of a demo publisher', () => {
  it('reaches a due payout created to the synthetic address, and the dry run port completes it', async () => {
    const app = await bootPackApp({}, { test_seed: SEED });
    try {
      const b = await app.db.query<{ id: string }>(
        `SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'`,
      );
      const who: Actor = { kind: 'buyer', buyer_id: b.rows[0]!.id };
      const offer = (await app.engine.listOffers()).find(
        (o) => o.publisher_slug === 'harbour-ledger',
      )!;
      const page = await app.engine.offerPage({
        publisher: 'harbour-ledger',
        offer: offer.offer_code,
      });
      const q = await app.engine.quote({
        offer: { publisher_slug: 'harbour-ledger', offer_code: offer.offer_code },
        actor: who,
        source: 'direct',
        option: page!.options[0]!.option,
      });
      if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
      const g = await app.engine.requestApproval({
        actor: who,
        selection: { kind: 'quote', quote_id: q.value.quote_id },
        consent: { terms: true, identity_share: false },
      });
      if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
      const placed = await app.engine.payments.placeOrder({
        approval_id: g.value.approval_id,
        token: g.value.token,
        actor: who,
      });
      if (!placed.ok) throw new Error('place refused');
      const co = await app.engine.payments.beginCheckout({
        order_id: placed.value.order_id,
        actor: who,
      });
      if (!co.ok) throw new Error('checkout refused');
      expect(
        await app.engine.dryRunApprove({
          order_ref: placed.value.order_ref,
          actor: who,
          scenario: 'happy',
        }),
      ).toBe(true);
      await app.engine.payments.onBuyerReturn({
        order_ref: placed.value.order_ref,
        actor: who,
        scenario: 'happy',
      });
      // before this change the pass cancelled nothing and created nothing: there was no payee
      vi.setSystemTime(NOW + 30 * DAY);
      expect(await app.engine.runPayouts()).toMatchObject({ created: 1, sent: 1, refused: 0 });
      const rows = (
        await app.db.query<{
          state: string;
          environment: string;
          payee_merchant_id: string;
          provider_ref: string | null;
        }>('SELECT state, environment, payee_merchant_id, provider_ref FROM payouts')
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'confirmed',
        environment: 'dryrun',
        payee_merchant_id: 'demo-harbour-ledger@payee.invalid',
      });
      expect(rows[0]!.provider_ref).toMatch(/^DRYRUN-umsP-pay_/);
    } finally {
      await app.close();
    }
  });
});
