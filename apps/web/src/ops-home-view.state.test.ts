// INT-OPS-A / OPS-A.1 and OPS-A.2: the four health lights of operator Home and the needs-you list with the shell
// bell. Each light word comes from one rule in lib/ops-health-view.ts (A5), tried here row by row against the
// table of the spec. The needs-you rows and the bell counts are AL's own read, passed through
// composition/ops-home.ts (A4), so they are compared with a seed of known size. The bell exists in the operator
// shell only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BLOCKED_BY, OPS_PAGES } from '@umsbx/contracts';
import { BLOCKED_WORDS, JOB_STALE_MS, healthLights } from './lib/ops-health-view';
import type { HealthInput } from './lib/ops-health-view';
import { bellCounts } from './lib/ops-alerts-view';
import { bootAlertRig, seedAlert } from './ops-alerts-support';
import type { AlertRig } from './ops-alerts-support';

vi.mock('server-only', () => ({}));

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const NOW = '2026-11-05T12:00:00.000Z';
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

const ok: HealthInput = {
  app: 'up',
  maintenance: false,
  db: true,
  environment: 'sandbox',
  switch_on: true,
  outbound: { open: true, blocked_by: null },
  last_pass_at: ago(10_000),
  now: NOW,
};
const word = (i: Partial<HealthInput>, id: string): string =>
  healthLights({ ...ok, ...i }).find((l) => l.id === id)!.word;

describe('OPS-A.1 the four lights', () => {
  it('shows App, Database, PayPal gateway and Job loop, in that order, each with a word', () => {
    const lights = healthLights(ok);
    expect(lights.map((l) => l.id)).toEqual(['app', 'database', 'paypal', 'jobs']);
    expect(lights.map((l) => l.label)).toEqual(['App', 'Database', 'PayPal gateway', 'Job loop']);
    expect(lights.map((l) => l.word)).toEqual(['up', 'up', 'on', 'running']);
  });

  it('App: up when health answered, unknown when the read threw', () => {
    expect(word({}, 'app')).toBe('up');
    expect(word({ app: 'unknown' }, 'app')).toBe('unknown');
  });

  it('Database: maintenance wins, then db true is up and false is down', () => {
    expect(word({ db: true }, 'database')).toBe('up');
    expect(word({ db: false }, 'database')).toBe('down');
    expect(word({ maintenance: true, db: false }, 'database')).toBe('closed for maintenance');
    expect(word({ maintenance: true, db: true }, 'database')).toBe('closed for maintenance');
  });

  it('PayPal gateway: dry-run, switched off, on, blocked by each lock, and unknown', () => {
    expect(word({ environment: 'dryrun', switch_on: true }, 'paypal')).toBe('off (dry-run)');
    expect(word({ environment: 'dryrun', outbound: null, switch_on: null }, 'paypal')).toBe(
      'off (dry-run)',
    );
    expect(word({ switch_on: false }, 'paypal')).toBe('off (switched off)');
    expect(word({ switch_on: true, outbound: { open: true, blocked_by: null } }, 'paypal')).toBe(
      'on',
    );
    expect(word({ switch_on: null }, 'paypal')).toBe('unknown');
    for (const by of BLOCKED_BY) {
      expect(word({ outbound: { open: false, blocked_by: by } }, 'paypal')).toBe(
        `blocked (${BLOCKED_WORDS[by]})`,
      );
    }
  });

  it('every BLOCKED_BY value has a plain word, and no word is a code', () => {
    expect(Object.keys(BLOCKED_WORDS).sort()).toEqual([...BLOCKED_BY].sort());
    for (const by of BLOCKED_BY) {
      expect(BLOCKED_WORDS[by].length).toBeGreaterThan(3);
      expect(BLOCKED_WORDS[by]).not.toMatch(/_/);
    }
  });

  it('Job loop: not run yet, stale after 300 s, running before', () => {
    expect(JOB_STALE_MS).toBe(300_000);
    expect(word({ last_pass_at: null }, 'jobs')).toBe('not run yet');
    expect(word({ last_pass_at: ago(301_000) }, 'jobs')).toBe('stale');
    expect(word({ last_pass_at: ago(299_000) }, 'jobs')).toBe('running');
    expect(word({ last_pass_at: ago(0) }, 'jobs')).toBe('running');
  });

  it('every light has a tone the Chip knows, and no word has a dash', () => {
    const tones = new Set(['good', 'warn', 'bad', 'info', 'neutral']);
    for (const i of [
      ok,
      { ...ok, db: false },
      { ...ok, environment: 'dryrun' as const },
      { ...ok, last_pass_at: null },
    ]) {
      for (const l of healthLights(i)) {
        expect(tones.has(l.tone)).toBe(true);
        expect(l.word).not.toMatch(/[–—]/);
      }
    }
  });
});

describe('OPS-A.2 needs-you and the bell, over AL read', () => {
  let rig: AlertRig;
  let home: typeof import('./composition/ops-home');
  beforeAll(async () => {
    rig = await bootAlertRig();
    home = await import('./composition/ops-home');
    // frozen_order is critical, payment_unresolved high, create_rejected medium, reversal_hint info.
    await seedAlert(rig.rig, { id: 'alr_h1', kind: 'frozen_order', reason: 'a' });
    await seedAlert(rig.rig, { id: 'alr_h2', kind: 'payment_unresolved', reason: 'b' });
    await seedAlert(rig.rig, { id: 'alr_h3', kind: 'payment_unresolved', reason: 'c' });
    await seedAlert(rig.rig, { id: 'alr_h4', kind: 'create_rejected', reason: 'd' });
    await seedAlert(rig.rig, { id: 'alr_h5', kind: 'reversal_hint', reason: 'e' });
  });
  afterAll(async () => rig?.rig.app.close());

  it('the needs-you rows are AL rows, unchanged', async () => {
    const mine = await home.readNeedsYou();
    expect(mine).toEqual(await rig.rig.app.engine.opsReads.needsYou());
    expect(mine.filter((r) => r.kind === 'open_alerts').reduce((n, r) => n + r.count, 0)).toBe(5);
  });

  it('the bell counts open alerts by severity from those rows', async () => {
    expect(bellCounts(await home.readNeedsYou())).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      info: 1,
      total: 5,
    });
    const afterAck = await home.readBellCounts();
    expect(afterAck.total).toBe(5);
  });

  it('the bell ignores rows that are not open alerts and sentences it cannot read', () => {
    expect(bellCounts([])).toEqual({ critical: 0, high: 0, medium: 0, info: 0, total: 0 });
    expect(
      bellCounts([
        { kind: 'applicants_waiting', sentence: '4 critical alerts are waiting for you.', href: '/ops/publishers', count: 4 },
        { kind: 'open_alerts', sentence: 'Something else.', href: '/ops', count: 9 },
        { kind: 'open_alerts', sentence: '1 high alert is waiting for you.', href: '/ops', count: 1 },
      ]),
    ).toEqual({ critical: 0, high: 1, medium: 0, info: 0, total: 1 });
  });

  it('every needs-you href is a page of the operator shell', async () => {
    await rig.rig.app.db.query(
      `INSERT INTO payee_change_requests (id, publisher_id, requested_merchant_id, note, created_by, created_at, updated_at)
       SELECT 'pcr_home1', id, 'SBXHOMEPAYEE1', 'x', 'publisher', now(), now() FROM publishers LIMIT 1`,
    );
    const pages: readonly string[] = OPS_PAGES;
    const rows = await home.readNeedsYou();
    expect(rows.length).toBeGreaterThan(2);
    for (const r of rows) expect(pages).toContain(r.href.split('#')[0]);
  });

  it('readHomeLights gives the four lights from the engine, the stored switch and the injected clock', async () => {
    const lights = await home.readHomeLights(rig.rig.operator as never);
    expect(lights.map((l) => l.id)).toEqual(['app', 'database', 'paypal', 'jobs']);
    expect(lights.find((l) => l.id === 'app')!.word).toBe('up');
    expect(lights.find((l) => l.id === 'database')!.word).toBe('up');
    expect(lights.find((l) => l.id === 'paypal')!.word).toBe('off (dry-run)');
    expect(lights.find((l) => l.id === 'jobs')!.word).toBe('not run yet');
  });
});

describe('OPS-A.2 the bell is in the operator shell only', () => {
  it('Shell.tsx shows AlertBell for the operator persona and for no other', () => {
    const shell = source('ui/shell/Shell.tsx');
    expect(shell).toContain("import { AlertBell } from './AlertBell'");
    expect(shell).toMatch(/persona === 'operator' \? <AlertBell \/> : null/);
    expect(shell.match(/AlertBell/g)).toHaveLength(2);
  });

  it('no other file imports AlertBell, so the buyer and seller shells cannot show it', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(here, dir)).flatMap((f) => {
        const rel = `${dir}/${f}`;
        return statSync(join(here, rel)).isDirectory() ? walk(rel) : [rel];
      });
    const users = walk('.')
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f))
      .filter((f) => /AlertBell/.test(readFileSync(join(here, f), 'utf8')));
    expect(users.sort()).toEqual(['./ui/shell/AlertBell.tsx', './ui/shell/Shell.tsx']);
  });

  it('the bell reads through ops-home.ts, shows only open alerts, and writes nothing', () => {
    const bell = source('ui/shell/AlertBell.tsx');
    expect(bell).toContain("from '../../composition/ops-home'");
    expect(bell).not.toMatch(/server\/access/);
    expect(bell).toMatch(/href="\/ops\/alerts"|href=\{'\/ops\/alerts'\}|\/ops\/alerts/);
    expect(bell).not.toMatch(/\b(fetch|postJson|INSERT|UPDATE)\b/);
  });
});
