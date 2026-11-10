// PUB-A1: three publisher personas behind one publisher passcode, and the read only /publisher home.
// The engine is driven through bootTestApp (offline, PGlite, seeded catalogue); the pages are .tsx
// files the unit runner does not compile, so their source is read as text.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { navItems } from './lib/nav';
import { PUBLISHER_PERSONAS } from './lib/publisher-copy';
import { PASSCODE, bootTestApp, signIn } from './support';

vi.mock('server-only', () => ({}));

const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const PSALT = 'ffeeddccbbaa99887766554433221100';
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

let app: App;
let bare: App;
let sessionRoute: typeof import('./app/api/session/route');

beforeAll(async () => {
  sessionRoute = await import('./app/api/session/route');
  app = await bootTestApp({
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(PUBLISHER_PASSCODE, PSALT),
  });
});
afterAll(async () => {
  await app.close();
  if (bare) await bare.close();
});

const idOf = async (slug: string): Promise<string> =>
  (await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])).rows[0]!
    .id;

describe('personas', () => {
  it('lists the three publisher personas and no bare publisher persona', () => {
    const p = app.engine.personas();
    expect(p).toEqual([
      'buyer-a',
      'buyer-b',
      'publisher-harbour-ledger',
      'publisher-quayside-gazette',
      'publisher-northfield-quarterly',
      'operator',
    ]);
    expect(p).not.toContain('publisher');
    expect(PUBLISHER_PERSONAS.map((x) => x.id)).toEqual([
      'publisher-harbour-ledger',
      'publisher-quayside-gazette',
      'publisher-northfield-quarterly',
    ]);
  });
});

describe('sign-in as a publisher', () => {
  it.each(PUBLISHER_PERSONAS.map((p) => [p.id, p.slug] as const))(
    '%s lands on its own publisher row',
    async (persona, slug) => {
      const s = await app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE });
      expect(s).not.toBeNull();
      expect(s!.actor).toEqual({ kind: 'publisher', publisher_id: await idOf(slug) });
      const home = await app.engine.publisherHome(s!.actor);
      const row = (
        await app.db.query<{ display_name: string }>(
          'SELECT display_name FROM publishers WHERE slug = $1',
          [slug],
        )
      ).rows[0]!;
      expect(home?.display_name).toBe(row.display_name);
    },
  );

  it('works through the session route and the cookie resolves to the same publisher', async () => {
    const s = await signIn(sessionRoute.POST, 'publisher-quayside-gazette', PUBLISHER_PASSCODE);
    expect(s).not.toBeNull();
    const actor = await app.engine.actorFromCookie(s!.cookie);
    expect(actor).toEqual({ kind: 'publisher', publisher_id: await idOf('quayside-gazette') });
  });

  it('the demo passcode never signs a publisher in', async () => {
    for (const p of PUBLISHER_PERSONAS) {
      expect(await app.engine.signIn({ persona: p.id, passcode: PASSCODE })).toBeNull();
      expect(await signIn(sessionRoute.POST, p.id, PASSCODE)).toBeNull();
    }
  });

  it('the publisher passcode signs nobody else in, and the old persona is gone', async () => {
    for (const persona of ['buyer-a', 'buyer-b', 'operator', 'publisher', 'nobody']) {
      expect(
        await app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE }),
        persona,
      ).toBeNull();
    }
    expect(await app.engine.signIn({ persona: 'publisher', passcode: PASSCODE })).toBeNull();
  });

  it('buyer sign-in with the demo passcode is unchanged', async () => {
    const s = await app.engine.signIn({ persona: 'buyer-a', passcode: PASSCODE });
    expect(s?.actor.kind).toBe('buyer');
  });

  it('with the publisher hash unset, publisher personas are refused and buyers still work', async () => {
    bare = await bootTestApp();
    for (const p of PUBLISHER_PERSONAS) {
      expect(await bare.engine.signIn({ persona: p.id, passcode: PASSCODE })).toBeNull();
      expect(await bare.engine.signIn({ persona: p.id, passcode: PUBLISHER_PASSCODE })).toBeNull();
    }
    expect(await bare.engine.signIn({ persona: 'buyer-b', passcode: PASSCODE })).not.toBeNull();
  });
});

describe('publisherHome', () => {
  it('returns name, status, live offers and the payee state, the last 4 only', async () => {
    const actor: Actor = { kind: 'publisher', publisher_id: await idOf('harbour-ledger') };
    const home = (await app.engine.publisherHome(actor))!;
    expect(Object.keys(home).sort()).toEqual([
      'display_name',
      'offers_live',
      'payee',
      'settlement',
      'status',
    ]);
    expect(home.status).toBe('active');
    const live = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM offers o
        WHERE o.publisher_id = $1 AND o.status = 'authorised' AND o.superseded_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM offers n WHERE n.id = o.id AND (n.created_at, n.version) > (o.created_at, o.version))`,
      [actor.publisher_id],
    );
    expect(home.offers_live).toBe(live.rows[0]!.n);
    expect(home.offers_live).toBeGreaterThan(0);
    const merchant = (
      await app.db.query<{ paypal_merchant_id: string }>(
        'SELECT paypal_merchant_id FROM publishers WHERE id = $1',
        [actor.publisher_id],
      )
    ).rows[0]!.paypal_merchant_id;
    expect(home.payee.last4).toBe(merchant.slice(-4));
    expect(home.payee.verified_at).not.toBeNull();
    expect(JSON.stringify(home)).not.toContain(merchant);
  });

  it('counts only offers a buyer can buy: Northfield sits behind a disabled corridor (gate 12 D9)', async () => {
    const id = await idOf('northfield-quarterly');
    const stored = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM offers WHERE publisher_id = $1 AND status = 'authorised'`,
      [id],
    );
    expect(stored.rows[0]!.n).toBeGreaterThan(0);
    // gb-gbp is enabled and wide since migration 0034; switch it off here to model the disabled corridor.
    await app.db.query(`UPDATE corridors SET enabled = false WHERE id = 'gb-gbp'`);
    try {
      const home = (await app.engine.publisherHome({ kind: 'publisher', publisher_id: id }))!;
      expect(home.offers_live).toBe(0);
    } finally {
      await app.db.query(`UPDATE corridors SET enabled = true WHERE id = 'gb-gbp'`);
    }
  });

  it('shows applied and suspended as stored, and an empty publisher with no payee', async () => {
    await app.db.query(
      `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
       VALUES ('pub_empty', 'empty-pub', 'Empty Pub', 'US', 'applied', '2026-10-30T10:00:00Z', '2026-10-30T10:00:00Z')`,
    );
    const actor: Actor = { kind: 'publisher', publisher_id: 'pub_empty' };
    expect(await app.engine.publisherHome(actor)).toEqual({
      display_name: 'Empty Pub',
      status: 'applied',
      offers_live: 0,
      payee: { last4: null, verified_at: null },
      // SETTLE-A: the home carries the one settlement sentence (a dry run here, so no money moved).
      settlement: { mode: 'dryrun', sentence: 'Dry run: no money moved.' },
    });
    await app.db.query(`UPDATE publishers SET status = 'suspended' WHERE id = 'pub_empty'`);
    expect((await app.engine.publisherHome(actor))?.status).toBe('suspended');
  });

  it('is null for a buyer, an operator and a publisher id that names no row', async () => {
    const buyer = (await app.engine.signIn({ persona: 'buyer-a', passcode: PASSCODE }))!.actor;
    expect(await app.engine.publisherHome(buyer)).toBeNull();
    expect(
      await app.engine.publisherHome({ kind: 'operator', operator_id: 'opr_x', mfa: false }),
    ).toBeNull();
    expect(
      await app.engine.publisherHome({ kind: 'publisher', publisher_id: 'pub_nobody' }),
    ).toBeNull();
  });
});

describe('the pages (source as text)', () => {
  const page = read('./app/publisher/page.tsx').replace(/\/\/.*$/gm, '');
  it('the publisher page redirects anyone but a publisher and reads only through the engine', () => {
    expect(page).toContain("redirect('/signin?next=/publisher')");
    expect(page).toMatch(/actor\?\.kind !== 'publisher'/);
    expect(page).toMatch(/engine\.publisherHome\(actor\)/);
    expect(page).toContain("from '../../lib/publisher-copy'");
    expect(page).not.toMatch(/style=/);
  });
  it('the layout shows the Publisher link to a publisher session only', () => {
    // FIX-FLOW D11: the header items now come from lib/nav.ts (the layout only renders them), so the
    // rule is pinned there, not in the layout source.
    const nav = read('./lib/nav.ts');
    expect(nav).toContain("href: '/publisher'");
    expect(nav).toContain('PUBLISHER_NAV_LABEL');
    expect(read('./app/layout.tsx')).toContain('navItems(');
    const hrefs = (k: Parameters<typeof navItems>[0]) => navItems(k).items.map((i) => i.href);
    expect(hrefs('publisher')).toContain('/publisher');
    for (const k of [null, 'buyer', 'operator'] as const)
      expect(hrefs(k)).not.toContain('/publisher');
  });
  it('the sign-in form lists the personas from the copy module and has no bare publisher entry', () => {
    const form = read('./app/signin/SignInForm.tsx');
    expect(form).toContain("from '../../lib/publisher-copy'");
    expect(form).not.toMatch(/id: 'publisher'/);
    expect(form).toMatch(/isPublisherPersona\(persona\)/);
  });
});
