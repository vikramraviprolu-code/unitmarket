// AGREE-1 (docs/specs/agree-1-agreement-record.md): the seeded, read-only publisher terms record over the
// real engine (offline, PGlite, seeded catalogue). A publisher reads only its own record; the operator
// list needs the second factor; nothing under app/ writes the table; the pages show the sentence, the
// link and the flag. The .tsx pages are not compiled by the unit runner, so their source is read as text.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { PUBLISHER_TERMS_VERSION } from './lib/legal-copy';
import { bootTestApp } from './support';

vi.mock('server-only', () => ({}));

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const OP: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
let app: App;
beforeAll(async () => {
  app = await bootTestApp();
});
afterAll(async () => {
  await app.close();
});
const idOf = async (slug: string): Promise<string> =>
  (await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])).rows[0]!
    .id;

describe('the seeded record', () => {
  it('exists for each demo publisher at the current terms version, as a seeded demo record', async () => {
    for (const slug of ['harbour-ledger', 'quayside-gazette', 'northfield-quarterly']) {
      const id = await idOf(slug);
      const a = await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: id });
      expect(a).not.toBeNull();
      expect(a).toMatchObject({
        publisher_id: id,
        terms_version: PUBLISHER_TERMS_VERSION,
        method: 'seeded_demo',
      });
      expect(a!.accepted_by_label.length).toBeGreaterThan(0);
    }
    const n = await app.db.query<{ c: string }>('SELECT count(*) AS c FROM publisher_agreements');
    expect(Number(n.rows[0]!.c)).toBe(3);
  });

  it('is one constant: the version lives in the legal copy module only', () => {
    expect(PUBLISHER_TERMS_VERSION).toMatch(/^v\d+$/);
    const src = read('./lib/legal-copy.ts');
    expect(src.match(/PUBLISHER_TERMS_VERSION/g)!.length).toBe(1);
  });
});

describe('who can read it', () => {
  it('a publisher reads only its own; a buyer, a system actor and an operator get none here', async () => {
    const h = await idOf('harbour-ledger');
    const q = await idOf('quayside-gazette');
    expect(
      (await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: h }))!.publisher_id,
    ).toBe(h);
    expect(
      (await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: q }))!.publisher_id,
    ).toBe(q);
    expect(await app.engine.publisherAgreement({ kind: 'buyer', buyer_id: 'buy_x' })).toBeNull();
    expect(await app.engine.publisherAgreement(OP)).toBeNull();
    expect(await app.engine.publisherAgreement({ kind: 'system' })).toBeNull();
    expect(
      await app.engine.publisherAgreement({ kind: 'publisher', publisher_id: 'pub_missing' }),
    ).toBeNull();
  });

  it('the operator list needs an operator with the second factor', async () => {
    const ok = await app.engine.opsAgreements.list(OP);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.agreements).toHaveLength(3);
    expect(
      await app.engine.opsAgreements.list({ kind: 'operator', operator_id: 'opr_v', mfa: false }),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    const pub: Actor = { kind: 'publisher', publisher_id: await idOf('harbour-ledger') };
    expect(await app.engine.opsAgreements.list(pub)).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
    expect(await app.engine.opsAgreements.list({ kind: 'buyer', buyer_id: 'buy_x' })).toEqual({
      ok: false,
      error: { code: 'not_operator' },
    });
  });
});

describe('no write path for a publisher', () => {
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) files(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };

  it('no file under app/ names the table, and the engine exposes reads only', () => {
    const appDir = join(__dirname, 'app');
    for (const f of files(appDir))
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/publisher_agreements/);
    const keys = Object.keys(app.engine).filter((k) => /agree/i.test(k));
    expect(keys.sort()).toEqual(['opsAgreements', 'publisherAgreement']);
    expect(Object.keys(app.engine.opsAgreements)).toEqual(['list']);
  });

  it('no route directory for agreements exists', () => {
    const routes = files(join(__dirname, 'app')).filter((f) => /route\.ts$/.test(f));
    for (const f of routes)
      expect(f.slice(join(__dirname, 'app').length)).not.toMatch(/agree|terms|accept/i);
  });
});

describe('the pages', () => {
  it('the publisher home shows the line and the link to the publisher terms, read only', () => {
    const src = read('./app/publisher/page.tsx');
    // PUB-UI-HOME: the page reads the record through a local engine handle and shows it as a chip with the
    // dated line from lib/publisher-home-copy.ts; the sentence is still the read only record, no form.
    expect(src).toContain('engine.publisherAgreement(actor)');
    expect(src).toContain('/legal/publisher-terms');
    expect(src).not.toMatch(/<form|<button|method=/);
  });

  it('the operator page shows the record per publisher, the flag and the applicant line', () => {
    const src = read('./app/ops/publishers/page.tsx');
    expect(src).toContain('engine.opsAgreements.list(actor)');
    expect(src).toContain('PUBLISHER_TERMS_VERSION');
    expect(src).toContain('agreementChangedText');
    expect(src).toContain('NOT_ACCEPTED_TEXT');
  });
});
