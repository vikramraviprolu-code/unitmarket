import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

// INT-CL1 item 11: one short runbook replaces the copy and paste guide for the cloud start, stop and deploy.
const RUNBOOK = join(REPO_ROOT, 'docs', 'owner', 'CLOUD-RUNBOOK.md');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const VERBS = ['doctor', 'status', 'up', 'down', 'restart', 'deploy', 'logs'];

describe('docs/owner/CLOUD-RUNBOOK.md', () => {
  const text = readFileSync(RUNBOOK, 'utf8');

  it('is at most 60 lines', () => {
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
  });

  it('every corepack pnpm cloud:<verb> in it exists in package.json', () => {
    const used = [...text.matchAll(/corepack pnpm (cloud:[a-z]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(pkg.scripts[u], u).toBeDefined();
  });

  it('names all seven verbs, and none that does not exist', () => {
    for (const v of VERBS) expect(text, v).toContain(`cloud:${v}`);
    expect(text).not.toMatch(/cloud:(?:on|connect|paypal|delete|destroy)/);
  });

  it('says that nothing here turns PayPal on, and that agents never run it for real', () => {
    expect(text).toMatch(
      /never turn[s]? PayPal on|does not turn PayPal on|PayPal (?:stays|is left) off/i,
    );
    expect(text).toMatch(/agent/i);
  });

  it('holds no secret value and no e-mail address', () => {
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});

describe('docs/owner/SAKTHI-DEPLOY-COPYPASTE.md', () => {
  it('points to the runbook for the deploy', () => {
    const t = readFileSync(join(REPO_ROOT, 'docs', 'owner', 'SAKTHI-DEPLOY-COPYPASTE.md'), 'utf8');
    expect(t).toContain('CLOUD-RUNBOOK.md');
    expect(t).toContain('cloud:deploy');
  });
});

describe('package.json cloud scripts', () => {
  it('map one to one to the seven verbs: bash infra/gcp/cloud.sh <verb>, and nothing else', () => {
    const cloud = Object.keys(pkg.scripts)
      .filter((k) => k.startsWith('cloud:'))
      .sort();
    expect(cloud).toEqual(VERBS.map((v) => `cloud:${v}`).sort());
    for (const v of VERBS) expect(pkg.scripts[`cloud:${v}`]).toBe(`bash infra/gcp/cloud.sh ${v}`);
  });
});
