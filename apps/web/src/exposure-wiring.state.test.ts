// INT-CTL / CTL.5 (F5): the app sets SecurityDeps.exposure in both blocks of the composition root, the deps object
// and the lazy securityDeps getters. A test that builds its own deps without it keeps every group enabled.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootTestApp } from './support';
import type { App } from '../composition.server';

vi.mock('server-only', () => ({}));

let app: App;
beforeAll(async () => {
  app = await bootTestApp();
});
afterAll(async () => app.close());

describe('SecurityDeps.exposure', () => {
  it("the app's security deps hold a reader that answers true for every seeded group", async () => {
    expect(app.security.exposure).toBeDefined();
    expect(await app.security.exposure!.isEnabled('orders')).toBe(true);
    expect(await app.security.exposure!.isEnabled('mcp:buy_unit')).toBe(true);
  });

  it('the exported securityDeps getter returns the same reader', async () => {
    const { securityDeps } = await import('../composition.server');
    expect(securityDeps.exposure).toBeDefined();
    expect(securityDeps.exposure).toBe(app.security.exposure);
  });

  it('the composition root names exposure in the deps object and in the getter block', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../composition.server.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/createExposureReader\(/);
    expect(src).toMatch(/exposure,?\s*\n?\s*\};?|exposure:\s*exposure/);
    expect(src).toMatch(/get exposure\(\)/);
  });
});
