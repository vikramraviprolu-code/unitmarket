import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeKit } from './cloud-kit-support';
import { FIXTURES } from './test-helpers';

// INT-CL1 item 3, the contract: `cloud status --json` has the shape pinned in scripts/__fixtures__/cloud-status.json,
// which the operator-screen lane (CTL.2) reads too. approval_ref_set replaces the plan's approval_ref_matches (R2-4).
type Svc = Record<string, unknown> & { name: string; state: string };
interface Doc {
  checked_at: string;
  project: string;
  services: Svc[];
}
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'cloud-status.json'), 'utf8')) as Doc;
const STATES = ['up', 'down', 'starting', 'stopping', 'error', 'absent'];
const NAMES = ['web', 'job_loop', 'database', 'offline_judge', 'paypal_gateway'];

const typeOf = (v: unknown): string => (v === null ? 'null' : typeof v);
const shape = (s: Svc): Record<string, string> =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeOf(v)]));

describe('the pinned fixture', () => {
  it('has the five parts in order, the agreed keys and a project', () => {
    expect(fixture.services.map((s) => s.name)).toEqual(NAMES);
    expect(typeof fixture.checked_at).toBe('string');
    expect(fixture.project).toBe('unitmarket-sbx-vr1');
    expect(Object.keys(fixture).sort()).toEqual(['checked_at', 'project', 'services']);
  });

  it('every state is in the enum; the gateway is on or off, the Cloud Run flag only', () => {
    for (const s of fixture.services.filter((x) => x.name !== 'paypal_gateway'))
      expect(STATES, s.name).toContain(s.state);
    const g = fixture.services.find((s) => s.name === 'paypal_gateway')!;
    expect(['on', 'off']).toContain(g.state);
    expect(['on', 'off']).toContain(g['flag']);
    expect(typeof g['approval_ref_set']).toBe('boolean');
    expect('approval_ref_matches' in g).toBe(false);
  });

  it('job_loop mirrors web; the offline part carries only name, state and last_error when absent', () => {
    const j = fixture.services.find((s) => s.name === 'job_loop')!;
    expect(j['runs_in']).toBe('web');
    const o = fixture.services.find((s) => s.name === 'offline_judge')!;
    expect(Object.keys(o).sort()).toEqual(['last_error', 'name', 'state']);
  });

  it('holds no secret value and no switch other than the flag', () => {
    expect(JSON.stringify(fixture)).not.toMatch(/secret|password|token|approval_ref_matches/i);
  });
});

describe('the real output', () => {
  it('equals the fixture shape: same keys and the same value types, per part', () => {
    const k = makeKit({ offline: false });
    const r = k.run(['status', '--json']);
    expect(r.status, r.out).toBe(0);
    const out = JSON.parse(r.stdout) as Doc;
    expect(Object.keys(out).sort()).toEqual(['checked_at', 'project', 'services']);
    expect(out.project).toBe(fixture.project);
    expect(out.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(out.services).toHaveLength(5);
    expect(out.services.map((s) => s.name)).toEqual(NAMES);
    out.services.forEach((s, i) => expect(shape(s), s.name).toEqual(shape(fixture.services[i]!)));
  });

  it('state is always in the enum, in a stack that is down as well', () => {
    for (const scenario of [
      {},
      { sqlPolicy: 'NEVER' as const, web: { min: 0, ingress: 'internal' as const } },
    ]) {
      const out = JSON.parse(makeKit(scenario).run(['status', '--json']).stdout) as Doc;
      for (const s of out.services.filter((x) => x.name !== 'paypal_gateway'))
        expect(STATES).toContain(s.state);
    }
  });

  it('makes no secret value call', () => {
    const k = makeKit();
    k.run(['status', '--json']);
    expect(k.gcloud().some((c) => /secrets versions access/.test(c))).toBe(false);
  });
});
