// MVP-A acceptance A-23 to A-27: fixtures map through the adapter and carry a source label, the
// adapted conformance suite passes against the dry-run transport, no secret name reaches the client
// bundle source, no live hostname in the tree, no import resolves outside the SBX root. These are
// independent scans written from the requirement text; the repository's own check scripts run as
// separate gate commands. Offline only; host names are built from parts.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CaptureReadSchema,
  CaptureResSchema,
  CreateOrderResSchema,
  OrderReadSchema,
  RefundResSchema,
} from '@umsbx/contracts';
import type { Transport } from '@umsbx/contracts';
import { createLogger } from '@umsbx/obs';
import { createPayPalAdapter } from '@umsbx/paypal';
import {
  describeDryRunOnly,
  describePayPalConformance,
  dryRunSubject,
  createReqFor,
  fakeClock,
  T0,
} from '@umsbx/testkit';
import { FixtureFileSchema } from '@umsbx/transport';
import type { FixtureFile } from '@umsbx/transport';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  '.turbo',
  'test-results',
  'playwright-report',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.push(abs);
    } else if (st.isDirectory()) {
      walk(abs, out);
    } else {
      out.push(abs);
    }
  }
  return out;
}
const allFiles = walk(ROOT);
const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/');

// ---------------------------------------------------------------------------------------------
describe('A-23 fixtures_map', () => {
  const dir = join(ROOT, 'fixtures', 'paypal');
  const files = walk(dir).filter((f) => f.endsWith('.json') && !f.endsWith('index.json'));
  const parsed = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }));

  it('there are fixtures to test', () => {
    expect(files.length).toBeGreaterThanOrEqual(60);
  });

  it('every fixture parses against the fixture schema and carries a source label and an origin', () => {
    const labels = new Map<string, number>();
    for (const { f, text } of parsed) {
      const fx = FixtureFileSchema.safeParse(JSON.parse(text));
      expect(fx.success, `${rel(f)} does not parse`).toBe(true);
      if (!fx.success) continue;
      expect(['docs-example', 'synthetic', 'sandbox-recording']).toContain(fx.data.meta.source);
      expect(fx.data.meta.origin.length).toBeGreaterThan(0);
      labels.set(fx.data.meta.source, (labels.get(fx.data.meta.source) ?? 0) + 1);
    }
    // MVP-A has no sandbox recording; nothing may claim to be one.
    expect(labels.get('sandbox-recording') ?? 0).toBe(0);
  });

  it('every fixture maps through the adapter to a valid port result', async () => {
    const log = createLogger(() => undefined, {}, fakeClock(T0));
    let mapped = 0;
    const byOp: Record<string, number> = {};
    for (const { f, text } of parsed) {
      const fx = FixtureFileSchema.parse(JSON.parse(text)) as FixtureFile;
      const op = fx.meta.operation;
      const transport: Transport = {
        kind: 'dryrun',
        async send() {
          if ('timeout' in fx.response) return { kind: 'timeout' };
          return {
            kind: 'response',
            status: fx.response.status,
            headers: { ...fx.response.headers },
            body:
              typeof fx.response.body === 'string'
                ? fx.response.body
                : JSON.stringify(fx.response.body),
            duration_ms: 1,
          };
        },
      };
      const port = createPayPalAdapter({
        transport,
        clock: fakeClock(T0),
        log,
        credentials: null,
        record: async () => undefined,
      });
      const id = fx.meta.expected_id ?? 'ABC123';
      switch (op) {
        case 'create_order':
          CreateOrderResSchema.parse(await port.createOrder(createReqFor(null, 'SBX9999')));
          break;
        case 'get_order':
          OrderReadSchema.parse(await port.getOrder(id));
          break;
        case 'capture_order':
          CaptureResSchema.parse(
            await port.captureOrder({
              provider_order_id: id,
              request_id: 'umsC-gate-req-0123456789abcdef0123456789',
            }),
          );
          break;
        case 'get_capture':
          CaptureReadSchema.parse(await port.getCapture(id));
          break;
        case 'refund_capture':
          RefundResSchema.parse(
            await port.refundCapture({
              capture_id: id,
              request_id: 'umsR-gate-req-0123456789abcdef0123456789',
              amount: null,
              note: 'gate',
            }),
          );
          break;
        case 'get_refund':
          RefundResSchema.parse(await port.getRefund(id));
          break;
        default:
          // oauth_token, webhook postback and certificate fixtures are parsed above; the adapter
          // reaches them only with credentials, which MVP-A never holds.
          continue;
      }
      mapped += 1;
      byOp[op] = (byOp[op] ?? 0) + 1;
      expect(f).toBeTruthy();
    }
    expect(mapped).toBeGreaterThanOrEqual(55);
    expect(Object.keys(byOp).sort()).toEqual([
      'capture_order',
      'create_order',
      'get_capture',
      'get_order',
      'get_refund',
      'refund_capture',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// A-24: the adapted C1 to C15 cases (P1..P15 in the testkit) and D1..D6 run against the dry-run
// transport. The suites register their own named tests.
describePayPalConformance(dryRunSubject());
describeDryRunOnly(dryRunSubject());

describe('A-24 conformance_dryrun', () => {
  it('the suites above are registered for the dry-run subject (P1..P15 and D1..D6)', () => {
    expect(dryRunSubject().name).toBe('dry-run');
  });
});

// ---------------------------------------------------------------------------------------------
describe('A-25 no_secret_in_bundle (source side; the build scan is the gate command)', () => {
  const web = allFiles.filter(
    (f) => rel(f).startsWith('apps/web/') && /\.(tsx?|mjs|js|json)$/.test(f),
  );
  const publicNames = new Set<string>();
  for (const f of web) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+\b/g))
      publicNames.add(m[0]);
  }

  it('the only NEXT_PUBLIC_ name in the app is the environment label', () => {
    expect([...publicNames].filter((n) => n !== 'NEXT_PUBLIC_UMS_ENV_LABEL')).toEqual([]);
  });

  it('no client component reads process.env or names a secret variable', () => {
    const SECRET =
      /\b(PAYPAL_CLIENT_SECRET|PAYPAL_CLIENT_ID|PAYPAL_WEBHOOK_ID|DATABASE_URL|UMS_[A-Z_]*SECRET|UMS_DEMO_PASSCODE_HASH|UMS_OUTBOUND_APPROVAL_REF)\b/;
    for (const f of web.filter((x) => /\.tsx?$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(text)) continue;
      expect(SECRET.test(text), `${rel(f)} names a secret in a client component`).toBe(false);
      expect(/process\.env/.test(text), `${rel(f)} reads process.env in a client component`).toBe(
        false,
      );
    }
  });

  it('.env.example holds names only (no value after an equals sign)', () => {
    const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      expect(
        /^[A-Z0-9_]+=$/.test(line.trim()),
        `value in .env.example: ${line.split('=')[0]}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('A-26 no_live_host_in_tree', () => {
  // Built from parts so this file carries no PayPal host text.
  const PP = ['paypal', 'com'].join('\\.');
  const HOST = new RegExp(`(?:[a-z0-9-]+\\.)*${PP}`, 'gi');
  const ALLOWED_SUB = new Set(
    [
      ['api-m', 'sandbox', 'paypal', 'com'],
      ['www', 'sandbox', 'paypal', 'com'],
      ['api', 'sandbox', 'paypal', 'com'],
      ['developer', 'paypal', 'com'],
    ].map((p) => p.join('.')),
  );
  const TEXT = /\.(ts|tsx|mts|js|mjs|cjs|json|md|yml|yaml|sql|css|html|txt|example)$/;
  const SANDBOX_SUFFIX = ['.sandbox', 'paypal', 'com'].join('.');

  it('no live PayPal hostname appears in any tracked text file', () => {
    const bad: string[] = [];
    for (const f of allFiles) {
      const r = rel(f);
      if (lstatSync(f).isSymbolicLink() || !(TEXT.test(f) || r.endsWith('.env.example'))) continue;
      if (r === 'pnpm-lock.yaml' || r.startsWith('tests/mvp-a/')) continue;
      // The policy (scripts/check-no-live-host.mjs) allows host names in markdown under docs/design/,
      // where they are named in order to be forbidden. The detector and its helper hold the patterns.
      if (r.startsWith('docs/design/') && r.endsWith('.md')) continue;
      if (r === 'scripts/check-no-live-host.mjs' || r === 'scripts/test-helpers.ts') continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(HOST)) {
        const host = m[0].toLowerCase();
        if (
          ALLOWED_SUB.has(host) ||
          host.endsWith(SANDBOX_SUFFIX) ||
          host === SANDBOX_SUFFIX.slice(1)
        )
          continue;
        bad.push(`${r}: ${host}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the sandbox base URL is one constant, in the transport package', () => {
    const SBX = ['api-m', 'sandbox', 'paypal', 'com'].join('.');
    const holders = allFiles
      .filter(
        (f) =>
          /\.(ts|tsx|mjs)$/.test(f) &&
          !rel(f).startsWith('tests/mvp-a/') &&
          !/\.(test|spec)\./.test(f),
      )
      .filter((f) => readFileSync(f, 'utf8').includes(SBX))
      .map(rel);
    expect(holders.filter((h) => !h.startsWith('scripts/'))).toEqual([
      'packages/transport/src/endpoints.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('A-27 isolation_from_simulation', () => {
  const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const SIM_REPO = ['AIC_Hackathon', 'UnitMarket'].join('_');
  const specifiers = (text: string): string[] => {
    const out: string[] = [];
    const patterns = [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /^\s*import\s+['"]([^'"]+)['"]/gm,
    ];
    for (const p of patterns) for (const m of text.matchAll(p)) out.push(m[1]!);
    return out;
  };

  it('no import specifier names the simulation scopes or repository', () => {
    const bad: string[] = [];
    for (const f of allFiles) {
      if (lstatSync(f).isSymbolicLink() || !CODE.test(f) || rel(f).startsWith('tests/mvp-a/'))
        continue;
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        if (
          /^@unitmarket(-sim)?\//.test(s) ||
          s.includes(SIM_REPO) ||
          /(^|\/)simulation(\/|$)/.test(s)
        ) {
          bad.push(`${rel(f)}: ${s}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('every relative specifier resolves inside the SBX root', () => {
    const bad: string[] = [];
    for (const f of allFiles) {
      // scripts/*.test.ts write import lines into temporary files as test data; they are not imports.
      if (
        lstatSync(f).isSymbolicLink() ||
        !CODE.test(f) ||
        /^scripts\/[^/]+\.test\.ts$/.test(rel(f))
      )
        continue;
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        if (!s.startsWith('.')) continue;
        const target = resolve(dirname(f), s);
        if (target !== ROOT.slice(0, -1) && !target.startsWith(ROOT)) bad.push(`${rel(f)}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no package.json or tsconfig names the simulation scopes, and no dependency is a path or git link', () => {
    const bad: string[] = [];
    for (const f of allFiles) {
      if (lstatSync(f).isSymbolicLink() || !/(^|\/)(package\.json|tsconfig[^/]*\.json)$/.test(f))
        continue;
      const text = readFileSync(f, 'utf8');
      if (/"@unitmarket(-sim)?\//.test(text) || text.includes(SIM_REPO))
        bad.push(`${rel(f)}: scope`);
      if (/"(?:link|file|portal|git\+[a-z]+|github):/.test(text))
        bad.push(`${rel(f)}: path or git dependency`);
    }
    expect(bad).toEqual([]);
  });

  it('there is no symbolic link anywhere in the tree', () => {
    expect(allFiles.filter((f) => lstatSync(f).isSymbolicLink()).map(rel)).toEqual([]);
  });
});
