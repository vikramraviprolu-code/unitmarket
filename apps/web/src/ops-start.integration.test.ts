// WEB-OPS-START (integration): the markup of the operator pages. Each page component is called with a
// stub engine, the result is rendered to static HTML, and the HTML is read: the Start and Stop forms on
// /ops (the one that does not apply is replaced by a sentence), and the section tabs on every operator
// page (each tab points at an id that exists once on the page). No server, no network, no database.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  actor: null as unknown,
  snap: null as unknown,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('./server/session', () => ({ currentActor: async () => h.actor }));
vi.mock('./server/access', () => ({
  app: async () => ({
    engine: {
      opsSnapshot: async () => h.snap,
      newKey: () => 'key-1',
      evalsSummary: async () => ({
        environment: 'dryrun',
        listing_cases: 1,
        brief_cases: 1,
        baseline: { passed: 2, total: 2 },
        cases: [{ id: 'case-1', kind: 'listing', pass: true, failed: [] }],
        claude: { state: 'not_run' },
        model_in_use: 'scripted',
      }),
      payee: {
        openRequests: async () => ({ ok: true, value: { requests: [], environment: 'dryrun' } }),
      },
      opsPublishers: {
        list: async () => ({ ok: true, value: { environment: 'dryrun', publishers: [] } }),
      },
      opsApplicants: { list: async () => ({ ok: true, value: { applicants: [] } }) },
      opsAgreements: { list: async () => ({ ok: true, value: { agreements: [] } }) },
    },
  }),
}));

const SCOPE = 'mvp_c_refunds';

function snapshot(o: { on: boolean; scope?: string | null; connect?: boolean }): unknown {
  return {
    environment: 'dryrun',
    switches: {
      paypal_outbound: o.on,
      checkout_enabled: true,
      refunds_enabled: false,
      unlock_enabled: true,
      ai_enabled: true,
      webhook_enabled: true,
    },
    gate: {
      mode: 'sandbox',
      connect: o.connect ?? false,
      approval_ref_set: true,
      transport: 'sandbox, approved transport behind five locks',
      outbound: {
        scope: SCOPE,
        wire_kind: 'production',
        locks: {
          l1_mode_sandbox: true,
          l2_connect_on: o.connect ?? false,
          l3_approval_active: true,
          l4_switch_on: o.on,
          l5_credentials_and_wire_ok: true,
        },
        open: false,
        blocked_by: 'connect_off',
        transport_built: false,
      },
      selfcheck: null,
    },
    orders: [],
    operations: [],
    alerts: [],
    invariants: [{ id: 'INV1', ok: true, detail: 'ok' }],
    kill_switch: {
      outbound_on: o.on,
      changed_by: 'operator:opr_vikram',
      changed_at: '2026-10-31T19:41:00.000Z',
      reason: 'stopped after D-062 tests',
      active_scope: o.scope === undefined ? SCOPE : o.scope,
      budget: {
        remaining_today: 110,
        max_calls_per_day: 120,
        valid_until: '2026-11-03T12:00:00.000Z',
      },
    },
    jobs: { last_pass_at: null, due: 0 },
    shared_payee: null,
    refunds: null,
  };
}

const operator = (mfa: boolean) => ({ kind: 'operator', operator_id: 'opr_vikram', mfa });

async function render(
  load: () => Promise<{ default: () => Promise<ReactElement> }>,
): Promise<string> {
  const mod = await load();
  return renderToStaticMarkup(await mod.default());
}
const ops = () => render(() => import('./app/ops/page'));

beforeEach(() => {
  h.actor = operator(true);
  h.snap = snapshot({ on: false });
});

const has = (html: string, testid: string): boolean => html.includes(`data-testid="${testid}"`);

describe('/ops Kill switch block', () => {
  it('switch Off, with the code: the Start form is shown and Stop is replaced by one sentence', async () => {
    const html = await ops();
    expect(has(html, 'ops-start-form')).toBe(true);
    expect(html).toContain('Start PayPal</button>');
    expect(html).toContain('Why are you starting PayPal calls?');
    // the active scope is a hint on the scope field, not a prefilled value
    expect(html).toMatch(/<input[^>]*id="start-scope"[^>]*>/);
    expect(html).toContain(SCOPE);
    expect(html).not.toMatch(/id="start-scope"[^>]*value=/);
    expect(has(html, 'ops-stop-form')).toBe(false);
    expect(has(html, 'ops-stop-replaced')).toBe(true);
    expect(html).not.toContain('Stop PayPal now</button>');
    expect(html).toContain('PayPal calls are already off, so there is nothing to stop.');
    expect(has(html, 'ops-start-replaced')).toBe(false);
  });

  it('switch On: the Stop form is shown and Start is replaced by one sentence', async () => {
    h.snap = snapshot({ on: true });
    const html = await ops();
    expect(has(html, 'ops-stop-form')).toBe(true);
    expect(html).toContain('Stop PayPal now</button>');
    expect(has(html, 'ops-start-form')).toBe(false);
    expect(has(html, 'ops-start-replaced')).toBe(true);
    expect(html).toContain('PayPal calls are already on, so there is nothing to start.');
    expect(html).not.toContain('Start PayPal</button>');
  });

  it('switch Off, no authenticator code: Start is replaced by the sign-in sentence', async () => {
    h.actor = operator(false);
    const html = await ops();
    expect(has(html, 'ops-start-form')).toBe(false);
    expect(has(html, 'ops-start-replaced')).toBe(true);
    expect(html).toContain('Sign in with your authenticator code to start PayPal.');
    expect(html).not.toContain('Start PayPal</button>');
  });

  it('switch Off with no active approval: the form says what is missing in words and names no scope', async () => {
    h.snap = snapshot({ on: false, scope: null });
    const html = await ops();
    expect(has(html, 'ops-start-form')).toBe(false);
    expect(has(html, 'ops-start-replaced')).toBe(true);
    expect(html).toContain('There is no active approval, so PayPal cannot be started from here.');
  });

  it('says in words that the connection flag is separate, whichever way it stands', async () => {
    const off = await ops();
    expect(off).toContain(
      'The connection flag is off. No PayPal call goes out until the owners turn it on in Cloud Run.',
    );
    h.snap = snapshot({ on: false, connect: true });
    const on = await ops();
    expect(on).not.toContain('The connection flag is off.');
  });

  it('keeps the stop and start controls keyboard reachable: real buttons and labelled inputs', async () => {
    const html = await ops();
    for (const id of ['start-reason', 'start-scope']) {
      expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      expect(html).toMatch(new RegExp(`<input[^>]*id="${id}"`));
    }
    expect(html).not.toMatch(/tabindex="-1"[^>]*>Start PayPal/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Start PayPal<\/button>/);
  });
});

describe('section tabs', () => {
  const pages: [string, () => Promise<string>][] = [
    ['/ops', ops],
    ['/ops/publishers', () => render(() => import('./app/ops/publishers/page'))],
    ['/ops/payee-requests', () => render(() => import('./app/ops/payee-requests/page'))],
    ['/ops/evals', () => render(() => import('./app/ops/evals/page'))],
  ];

  it.each(pages)(
    '%s has a tab bar whose every tab points at one section id on the page',
    async (_p, load) => {
      const html = await load();
      expect(has(html, 'section-nav')).toBe(true);
      const nav = /<nav class="section-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
      const targets = [...nav.matchAll(/href="#([^"]+)"/g)]
        .map((m) => m[1] as string)
        .filter((t) => t !== 'main');
      expect(targets.length).toBeGreaterThanOrEqual(2);
      expect(new Set(targets).size).toBe(targets.length);
      for (const t of targets) {
        const found = html.match(new RegExp(`\\sid="${t}"`, 'g')) ?? [];
        expect(found, `${t} must be an id on the page exactly once`).toHaveLength(1);
      }
    },
  );

  it('/ops lists the sections it has, in page order', async () => {
    const html = await ops();
    const nav = /<nav class="section-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    const targets = [...nav.matchAll(/href="#([^"]+)"/g)]
      .map((m) => m[1])
      .filter((t) => t !== 'main');
    expect(targets).toEqual([
      'ops-switches',
      'ops-kill',
      'ops-gate-section',
      'ops-refunds',
      'ops-orders',
      'ops-states',
      'ops-alerts',
      'ops-invariants',
    ]);
    const positions = targets.map((t) => html.indexOf(` id="${String(t)}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('every operator page that is longer than two screens has the tabs: no /ops/* page is left out', async () => {
    const { readdirSync, statSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, 'app', 'ops');
    const pagesFound: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n === 'page.tsx') pagesFound.push(p);
      }
    };
    walk(root);
    expect(pagesFound.length).toBeGreaterThanOrEqual(4);
    for (const p of pagesFound) expect(readFileSync(p, 'utf8'), p).toContain('<SectionNav');
  });
});
