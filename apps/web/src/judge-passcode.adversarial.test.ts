// JUDGE-A adversarial: the judge passcode signs buyers in and nobody else. It never opens the operator or a
// publisher persona, the other passcodes never open it, and timing gives no oracle.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPasscode, verifyPasscode } from '@umsbx/security';
import type { App } from '../composition.server';
import { PUBLISHER_PERSONAS } from './lib/publisher-copy';
import { PASSCODE, bootTestApp, call, signIn } from './support';

vi.mock('server-only', () => ({}));
vi.mock('@umsbx/security', async (orig) => {
  const m = await orig<typeof import('@umsbx/security')>();
  return { ...m, verifyPasscode: vi.fn(m.verifyPasscode) };
});

const JUDGE_PASSCODE = 'judge passcode for tests only';
const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const WRONG = 'a passcode nobody holds';
const BUYERS = ['buyer-a', 'buyer-b'] as const;
const PUBLISHERS = PUBLISHER_PERSONAS.map((p) => p.id);

let app: App;
let bare: App;
let sessionRoute: typeof import('./app/api/session/route');

beforeAll(async () => {
  sessionRoute = await import('./app/api/session/route');
  app = await bootTestApp({
    UMS_JUDGE_PASSCODE_HASH: await hashPasscode(JUDGE_PASSCODE, '0f1e2d3c4b5a69788796a5b4c3d2e1f0'),
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(
      PUBLISHER_PASSCODE,
      'ffeeddccbbaa99887766554433221100',
    ),
  });
  bare = await bootTestApp();
});
afterAll(async () => {
  await app.close();
  await bare.close();
});
beforeEach(() => {
  vi.mocked(verifyPasscode).mockClear();
});

describe('the judge passcode', () => {
  it.each(BUYERS)('signs %s in, as a buyer', async (persona) => {
    const s = await app.engine.signIn({ persona, passcode: JUDGE_PASSCODE });
    expect(s?.actor.kind).toBe('buyer');
    expect(await app.engine.actorFromCookie(s!.cookie)).toEqual(s!.actor);
  });

  it('signs a buyer in through the session route', async () => {
    expect(await signIn(sessionRoute.POST, 'buyer-a', JUDGE_PASSCODE)).not.toBeNull();
  });

  it('never signs the operator in, with or without an operator name and a code', async () => {
    expect(await app.engine.signIn({ persona: 'operator', passcode: JUDGE_PASSCODE })).toBeNull();
    expect(
      await app.engine.signIn({
        persona: 'operator',
        passcode: JUDGE_PASSCODE,
        operator: 'owner',
        code: '000000',
      }),
    ).toBeNull();
    expect(await signIn(sessionRoute.POST, 'operator', JUDGE_PASSCODE)).toBeNull();
  });

  it.each(PUBLISHERS)('never signs %s in', async (persona) => {
    expect(await app.engine.signIn({ persona, passcode: JUDGE_PASSCODE })).toBeNull();
    expect(await signIn(sessionRoute.POST, persona, JUDGE_PASSCODE)).toBeNull();
  });

  it.each(['publisher', 'nobody', '', 'BUYER-A', 'buyer-a '])(
    'never signs the unknown persona %j in',
    async (persona) => {
      expect(await app.engine.signIn({ persona, passcode: JUDGE_PASSCODE })).toBeNull();
    },
  );
});

describe('the other passcodes', () => {
  it('the publisher passcode never signs a buyer or the operator in', async () => {
    for (const persona of [...BUYERS, 'operator']) {
      expect(await app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE }), persona).toBeNull();
    }
  });

  it('the publisher passcode still signs the publishers in, and the demo passcode never does', async () => {
    for (const persona of PUBLISHERS) {
      expect((await app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE }))?.actor.kind).toBe(
        'publisher',
      );
      expect(await app.engine.signIn({ persona, passcode: PASSCODE })).toBeNull();
    }
  });

  it('the demo passcode is unchanged: it signs buyers and the operator in', async () => {
    for (const persona of BUYERS) {
      expect((await app.engine.signIn({ persona, passcode: PASSCODE }))?.actor.kind).toBe('buyer');
    }
    expect((await app.engine.signIn({ persona: 'operator', passcode: PASSCODE }))?.actor.kind).toBe(
      'operator',
    );
  });

  it('a wrong passcode signs nobody in', async () => {
    for (const persona of [...BUYERS, 'operator', ...PUBLISHERS]) {
      expect(await app.engine.signIn({ persona, passcode: WRONG }), persona).toBeNull();
    }
  });
});

describe('with the judge hash unset nothing changes', () => {
  it('the judge passcode signs nobody in, the demo passcode signs buyers and the operator in', async () => {
    for (const persona of [...BUYERS, 'operator', ...PUBLISHERS]) {
      expect(await bare.engine.signIn({ persona, passcode: JUDGE_PASSCODE }), persona).toBeNull();
    }
    for (const persona of [...BUYERS, 'operator']) {
      expect(await bare.engine.signIn({ persona, passcode: PASSCODE }), persona).not.toBeNull();
    }
  });
});

describe('no timing oracle', () => {
  const count = async (a: App, persona: string, passcode: string): Promise<number> => {
    vi.mocked(verifyPasscode).mockClear();
    await a.engine.signIn({ persona, passcode });
    return vi.mocked(verifyPasscode).mock.calls.length;
  };

  it('an unknown persona costs one verification', async () => {
    expect(await count(app, 'nobody', JUDGE_PASSCODE)).toBe(1);
    expect(await count(bare, 'nobody', JUDGE_PASSCODE)).toBe(1);
  });

  it('a publisher persona with the publisher hash unset costs one verification', async () => {
    for (const p of PUBLISHERS) expect(await count(bare, p, JUDGE_PASSCODE), p).toBe(1);
  });

  it('a buyer costs the same whether the demo, the judge or a wrong passcode is typed', async () => {
    const demo = await count(app, 'buyer-a', PASSCODE);
    const judge = await count(app, 'buyer-a', JUDGE_PASSCODE);
    const wrong = await count(app, 'buyer-a', WRONG);
    expect(new Set([demo, judge, wrong]).size).toBe(1);
  });

  it('the operator and a publisher cost one verification, so the judge hash adds no extra step there', async () => {
    expect(await count(app, 'operator', JUDGE_PASSCODE)).toBe(1);
    for (const p of PUBLISHERS) expect(await count(app, p, JUDGE_PASSCODE), p).toBe(1);
  });

  it('every refusal through the route has the same status and body', async () => {
    const bodies = new Set<string>();
    for (const [persona, passcode] of [
      ['operator', JUDGE_PASSCODE],
      ['publisher-harbour-ledger', JUDGE_PASSCODE],
      ['buyer-a', WRONG],
      ['nobody', JUDGE_PASSCODE],
    ] as const) {
      const res = await call(sessionRoute.POST, {
        url: '/api/session',
        method: 'POST',
        body: { persona, passcode },
      });
      bodies.add(`${res.status} ${await res.text()}`);
    }
    expect(bodies.size).toBe(1);
  });
});
