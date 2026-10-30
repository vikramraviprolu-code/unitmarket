// PUB-A1 adversarial: one publisher never reads another publisher's row, whatever the request carries,
// and the passcodes stay apart.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { PUBLISHER_PERSONAS } from './lib/publisher-copy';
import { PASSCODE, bootTestApp, call, signIn } from './support';

vi.mock('server-only', () => ({}));

const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

let app: App;
let sessionRoute: typeof import('./app/api/session/route');
let library: typeof import('./app/api/library/route');

beforeAll(async () => {
  sessionRoute = await import('./app/api/session/route');
  library = await import('./app/api/library/route');
  app = await bootTestApp({
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(
      PUBLISHER_PASSCODE,
      'ffeeddccbbaa99887766554433221100',
    ),
  });
});
afterAll(async () => {
  await app.close();
});

async function actorOf(persona: string): Promise<Actor> {
  const s = await signIn(sessionRoute.POST, persona, PUBLISHER_PASSCODE);
  const a = await app.engine.actorFromCookie(s!.cookie);
  return a!;
}

describe('isolation between publishers', () => {
  it("each session reads its own row and never another publisher's, for every pair", async () => {
    const actors = new Map<string, Actor>();
    for (const p of PUBLISHER_PERSONAS) actors.set(p.slug, await actorOf(p.id));
    const names = new Map<string, string>();
    for (const [slug, a] of actors) {
      const home = (await app.engine.publisherHome(a))!;
      names.set(slug, home.display_name);
    }
    expect(new Set(names.values()).size).toBe(3);
    for (const [slug, a] of actors) {
      const home = (await app.engine.publisherHome(a))!;
      for (const [other, name] of names) {
        if (other !== slug) expect(home.display_name).not.toBe(name);
      }
    }
  });

  it("a second argument or an extra field carrying another publisher's id changes nothing", async () => {
    const a = await actorOf('publisher-harbour-ledger');
    const b = await actorOf('publisher-quayside-gazette');
    if (a.kind !== 'publisher' || b.kind !== 'publisher') throw new Error('publisher expected');
    const mine = await app.engine.publisherHome(a);
    const loose = app.engine.publisherHome as unknown as (...args: unknown[]) => Promise<unknown>;
    expect(
      await loose({ ...a, publisher_id: a.publisher_id, other: b.publisher_id }, b.publisher_id),
    ).toEqual(mine);
    expect(await loose(a, { publisher_id: b.publisher_id })).toEqual(mine);
  });

  it('the page takes no id from the request: no params, no search params, no query string', () => {
    const page = read('./app/publisher/page.tsx').replace(/\/\/.*$/gm, '');
    expect(page).not.toMatch(/searchParams|params|headers\(|cookies\(/);
    expect(page).not.toMatch(/publisher_id/);
  });

  it('a publisher session is not a buyer session', async () => {
    const s = await signIn(sessionRoute.POST, 'publisher-northfield-quarterly', PUBLISHER_PASSCODE);
    const res = await call(library.GET, { url: '/api/library', session: s });
    expect([401, 403]).toContain(res.status);
  });

  it('a buyer session gets no publisher home', async () => {
    const s = await signIn(sessionRoute.POST, 'buyer-a', PASSCODE);
    const actor = (await app.engine.actorFromCookie(s!.cookie))!;
    expect(await app.engine.publisherHome(actor)).toBeNull();
    expect(await app.engine.publisherHome(actor)).toBeNull();
  });
});

describe('the two passcodes stay apart', () => {
  it('a wrong publisher passcode and the demo passcode give the same refusal as an unknown persona', async () => {
    const answers: unknown[] = [];
    for (const [persona, passcode] of [
      ['publisher-harbour-ledger', 'wrong'],
      ['publisher-harbour-ledger', PASSCODE],
      ['publisher-nobody', PUBLISHER_PASSCODE],
    ] as const) {
      const res = await call(sessionRoute.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona, passcode },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      // the support code is random per answer; everything else must be identical
      const { error } = (await res.json()) as { error: Record<string, unknown> };
      delete error['support_code'];
      answers.push(error);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('a buyer persona with the publisher passcode and a publisher persona with the demo passcode both fail', async () => {
    expect(await signIn(sessionRoute.POST, 'buyer-a', PUBLISHER_PASSCODE)).toBeNull();
    expect(await signIn(sessionRoute.POST, 'operator', PUBLISHER_PASSCODE)).toBeNull();
    expect(await signIn(sessionRoute.POST, 'publisher-harbour-ledger', PASSCODE)).toBeNull();
  });
});
