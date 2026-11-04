// API-W2 (item P1): the MVP 1 demo story end to end, P1-01 to P1-11, through the route handlers of the
// booted offline app (dry-run, nothing reaches PayPal or any network). The steps are in story.ts; each is
// one titled test here, in order, and each leaves on the rig what the next one needs. This file loads no
// product code of its own: a failing step is a stop-and-report to the lane that owns the route.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STEPS, bootStory } from './story';
import type { Rig } from './story';

vi.mock('server-only', () => ({}));

describe('MVP 1 API: an agent with a $5.00 cap buys end to end', () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await bootStory();
  }, 180_000);
  afterAll(async () => {
    await rig?.app.close();
  });

  for (const s of STEPS) {
    it(`${s.id} ${s.title}`, async () => {
      await s.run(rig);
    }, 180_000);
  }

  it('the story ran every step in order', () => {
    expect(STEPS.map((s) => s.id)).toEqual(
      Array.from({ length: 11 }, (_, i) => `P1-${String(i + 1).padStart(2, '0')}`),
    );
  });
});
