// INT-CTL / CTL.2: the services panel. CL1's fixture renders five cards; the commands equal the seven cloud:*
// scripts of package.json; every link starts with https://console.cloud.google.com/ and is built by the view only
// from the validated project. The panel itself holds no HTML injection, no fetch and no POST.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUD_COMMANDS, parseCloudStatus, servicesView } from './lib/services-view';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..', '..');
const fixtureText = readFileSync(join(root, 'scripts', '__fixtures__', 'cloud-status.json'), 'utf8');
const fixture = JSON.parse(fixtureText) as { project: string };
const BASE = 'https://console.cloud.google.com/';

const parsed = () => {
  const r = parseCloudStatus(fixtureText);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const links = (v: ReturnType<typeof servicesView>): string[] =>
  v.cards.flatMap((c) => [c.cloud_shell_url, c.audit_url]).filter((x): x is string => x !== null);

describe('the fixture of CL1', () => {
  it('parses, and renders five cards in order: web, job loop, database, offline judge, PayPal gateway', () => {
    const v = servicesView({ app: { revision: 'unitmarket-sandbox-00031-x7k', db: 'ok' }, cloud: parsed() });
    expect(v.cards.map((c) => c.key)).toEqual(['web', 'job_loop', 'database', 'offline_judge', 'paypal_gateway']);
    expect(v.cards.map((c) => c.title)).toEqual(['Web', 'Job loop', 'Database', 'Offline judge', 'PayPal gateway']);
    expect(v.checked_at).toBe('2026-11-04T22:40:00Z');
    expect(v.cards.find((c) => c.key === 'web')!.state).toBe('up');
    expect(v.cards.find((c) => c.key === 'offline_judge')!.state).toBe('absent');
    expect(v.cards.find((c) => c.key === 'paypal_gateway')!.state).toBe('off');
  });

  it('every card is plain strings: no markup, and the cloud values appear only as text', () => {
    const v = servicesView({ app: null, cloud: parsed() });
    const flat = JSON.stringify(v);
    expect(flat).not.toMatch(/<\w|dangerouslySetInnerHTML/);
    for (const c of v.cards) {
      expect(typeof c.title).toBe('string');
      expect(c.lines.every((l) => typeof l === 'string')).toBe(true);
    }
  });

  it('the app side comes from /api/v1/status: revision and db are shown on the web and database cards', () => {
    const v = servicesView({ app: { revision: 'rev-abc', db: 'ok' }, cloud: null });
    expect(v.cards.find((c) => c.key === 'web')!.lines.join(' ')).toContain('rev-abc');
    expect(v.cards.find((c) => c.key === 'database')!.lines.join(' ')).toMatch(/ok/);
    expect(v.cloud_pasted).toBe(false);
  });

  it('with no paste the cloud state says so, never a guess', () => {
    const v = servicesView({ app: null, cloud: null });
    expect(v.cards).toHaveLength(5);
    for (const c of v.cards) expect(c.state).toBe('unknown');
    expect(v.cards.every((c) => c.cloud_shell_url === null && c.audit_url === null)).toBe(true);
  });
});

describe('commands and links', () => {
  it('the commands equal the seven cloud:* scripts of package.json, in order', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const verbs = Object.keys(pkg.scripts).filter((k) => k.startsWith('cloud:')).map((k) => k.slice(6));
    expect(verbs).toHaveLength(7);
    expect([...CLOUD_COMMANDS]).toEqual(verbs.map((v) => `corepack pnpm cloud:${v}`));
  });

  it('each card shows only commands from that list, and together they use all seven', () => {
    const v = servicesView({ app: null, cloud: parsed() });
    const used = new Set<string>();
    for (const c of v.cards) {
      expect(c.commands.length, c.key).toBeGreaterThan(0);
      for (const cmd of c.commands) {
        expect(CLOUD_COMMANDS, c.key).toContain(cmd);
        used.add(cmd);
      }
    }
    expect([...used].sort()).toEqual([...CLOUD_COMMANDS].sort());
  });

  it('every link starts with the console base and carries the encoded project; no Phase 2 button exists', () => {
    const v = servicesView({ app: null, cloud: parsed() });
    const all = links(v);
    expect(all.length).toBe(10);
    for (const l of all) {
      expect(l.startsWith(BASE), l).toBe(true);
      expect(l).toContain(encodeURIComponent(fixture.project));
      expect(l).not.toMatch(/["'<>\s]|javascript:/i);
    }
    expect(JSON.stringify(v)).not.toMatch(/phase 2/i);
  });
});

describe('the panel source (C2)', () => {
  const src = readFileSync(join(here, 'ui/ops/ServicesPanel.tsx'), 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  it('holds no dangerouslySetInnerHTML, innerHTML, fetch or POST, and no button that acts on the cloud', () => {
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|fetch\(|method:\s*'POST'|<form\b/);
    expect(src).not.toMatch(/gcloud|cloud:(up|down|restart|deploy)\s*\)/);
  });
});
