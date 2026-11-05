// INT-OPS-B / OPS-B.5: the trace verify tile on Controls > Invariants, and the "verified" mark of every
// timeline. traceVerifyDetail(actor) in composition/ops-controls.ts runs TR0's in-process verify on the app
// database for an operator session; lib/verify-view.ts words the answer and the mark. The tile's "Run verify"
// is a link to ?verify=1 (N-B1): no route, no server action, and nothing runs on a plain page render.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { TraceContext } from '@umsbx/contracts';
import { NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { TIMELINE_FIXTURES } from './lib/timeline-view';
import type { TimelineEntryView } from './lib/timeline-view';
import {
  INVARIANTS_HREF,
  RUN_VERIFY_HREF,
  timelineMark,
  verifyTileView,
} from './lib/verify-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

let rig: StartRig;
let controls: typeof import('./composition/ops-controls');

const ctx: TraceContext = {
  id: 'ctx_verify_1',
  at: '2026-11-04T12:00:00.000Z',
  channel: 'job',
  actor_kind: 'system',
  actor_id: null,
  on_behalf_of: null,
  mandate_id: null,
  mfa: false,
  req_id: null,
  ip_hash: null,
  ua_family: null,
  api_key_id: null,
  job: 'probe',
  tool: null,
};
const OPERATOR = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rig = await bootStartRig();
  controls = await import('./composition/ops-controls');
  for (const n of [1, 2, 3])
    await withTraceContext({ ...ctx, id: `ctx_verify_${n}` }, () =>
      rig.app.db.query(
        `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ($1::text, 'job_probe', '{}'::jsonb, '2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z')`,
        [`alr_ver_${n}`],
      ),
    );
});
afterAll(async () => {
  await rig?.app.close();
});

// The cases run in this order on one database: healthy first, then a drift, then a broken chain. Each tamper
// switches the guard trigger off first (the way TR0's adversarial suite does) and stays, so a later case also
// sees the earlier findings.
describe('OPS-B.5 the tile on a healthy database', () => {
  it('traceVerifyDetail gives ok with counts and no lines', async () => {
    const d = await controls.traceVerifyDetail(OPERATOR);
    expect(d).not.toBeNull();
    expect(d!.ok).toBe(true);
    expect(d!.chains).toBeGreaterThan(0);
    expect(d!.rows).toBeGreaterThanOrEqual(3);
    expect(d!.seals).toBeGreaterThanOrEqual(0);
    expect(d!.lines).toEqual([]);
    expect(Object.keys(d!).sort()).toEqual(['chains', 'lines', 'ok', 'rows', 'seals']);
  });

  it('says "Verified" with the counts, and offers the run link and the platform invariants link', async () => {
    const d = await controls.traceVerifyDetail(OPERATOR);
    const tile = verifyTileView({ state: 'ran', detail: d! });
    expect(tile.kind).toBe('ok');
    expect(tile.headline).toBe('Verified');
    const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
    expect(tile.counts).toBe(
      `${n(d!.chains, 'chain')}, ${n(d!.rows, 'row')}, ${n(d!.seals, 'seal')} checked`,
    );
    expect(tile.lines).toEqual([]);
    expect(tile.runHref).toBe(RUN_VERIFY_HREF);
    expect(RUN_VERIFY_HREF).toBe('/ops/controls/invariants?verify=1');
    expect(INVARIANTS_HREF).toBe('/ops/money#ops-invariants');
    expect(tile.invariantsHref).toBe(INVARIANTS_HREF);
  });

  it('the idle tile (no verify yet) says nothing was run and has no result', () => {
    const tile = verifyTileView({ state: 'idle' });
    expect(tile.kind).toBe('idle');
    expect(tile.headline).toBe('Not run yet');
    expect(tile.counts).toBeNull();
    expect(tile.runHref).toBe(RUN_VERIFY_HREF);
  });

  it('refuses a buyer, a seller and the system actor (N-B2)', async () => {
    expect(await controls.traceVerifyDetail({ kind: 'buyer', buyer_id: 'buy_1' })).toBeNull();
    expect(await controls.traceVerifyDetail({ kind: 'publisher', publisher_id: 'pub_1' })).toBeNull();
    expect(await controls.traceVerifyDetail({ kind: 'system' })).toBeNull();
    expect(verifyTileView({ state: 'refused' })).toMatchObject({ kind: 'refused', lines: [] });
  });
});

describe('OPS-B.5 a drift names the table, the id and the column', () => {
  it('shows a drift line and the failed tile', async () => {
    await rig.app.db.exec('ALTER TABLE alerts DISABLE TRIGGER trace_capture_alerts');
    await rig.app.db.exec("UPDATE alerts SET kind = 'tampered' WHERE id = 'alr_ver_2'");
    const d = await controls.traceVerifyDetail(OPERATOR);
    expect(d!.ok).toBe(false);
    const line = d!.lines.find((l) => /drift/.test(l) && /alerts alr_ver_2 kind/.test(l));
    expect(line, JSON.stringify(d!.lines)).toBeDefined();
    const tile = verifyTileView({ state: 'ran', detail: d! });
    expect(tile.kind).toBe('broken');
    expect(tile.headline).toBe('Does not match');
    expect(tile.lines).toContain(line);
  });
});

describe('OPS-B.5 a broken chain names the chain and the row', () => {
  it('shows a chain line with the chain key and the seq', async () => {
    await rig.app.db.exec('ALTER TABLE trace_events DISABLE TRIGGER trace_events_append_only');
    await rig.app.db.exec(
      "UPDATE trace_events SET mfa = NOT mfa WHERE source_table = 'alerts' AND source_id = 'alr_ver_3'",
    );
    const d = await controls.traceVerifyDetail(OPERATOR);
    expect(d!.ok).toBe(false);
    const line = d!.lines.find((l) => /^chain plat seq \d+/.test(l));
    expect(line, JSON.stringify(d!.lines)).toBeDefined();
    const tile = verifyTileView({ state: 'ran', detail: d! });
    expect(tile.kind).toBe('broken');
    expect(tile.firstProblem).toMatch(/^chain plat seq \d+/);
  });

  it('fixture lines are worded the same way without a database', () => {
    const tile = verifyTileView({
      state: 'ran',
      detail: {
        ok: false,
        chains: 7,
        rows: 40,
        seals: 1,
        lines: [
          'chain ord:ord_1 seq 4: row_hash does not match the row',
          'drift orders ord_1 status',
        ],
      },
    });
    expect(tile.kind).toBe('broken');
    expect(tile.firstProblem).toBe('chain ord:ord_1 seq 4: row_hash does not match the row');
    expect(tile.lines).toHaveLength(2);
    expect(tile.counts).toBe('7 chains, 40 rows, 1 seal checked');
  });

  it('shows at most 20 lines and says how many more there are', () => {
    const lines = Array.from({ length: 31 }, (_, i) => `chain c${i} seq 1: x`);
    const tile = verifyTileView({ state: 'ran', detail: { ok: false, chains: 1, rows: 1, seals: 0, lines } });
    expect(tile.lines).toHaveLength(20);
    expect(tile.more).toBe('and 11 more');
  });
});

describe('OPS-B.5 the page runs verify only on request (N-B1)', () => {
  const page = source('app/ops/controls/invariants/page.tsx');

  it('checks for an operator first and reads only from the Controls module', () => {
    expect(page).toMatch(/if \(actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/controls\/invariants'\);/);
    expect(page).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/composition\/ops-controls'/);
    expect(page).not.toMatch(/composition\.server|server\/access/);
  });

  it('calls traceVerifyDetail only when ?verify=1 is present, after the operator check', () => {
    expect(page.indexOf('traceVerifyDetail(')).toBeGreaterThan(page.indexOf('redirect('));
    expect(page).toMatch(/verify\s*===\s*'1'[\s\S]*traceVerifyDetail\(/);
    expect(page.match(/traceVerifyDetail\(/g)).toHaveLength(1);
  });

  it('has no route and no server action for it', () => {
    expect(page).not.toMatch(/'use server'|"use server"/);
    expect(source('ui/ops/VerifyTile.tsx')).not.toMatch(/'use server'|"use server"|fetch\s*\(|<form/);
    expect(source('ui/ops/VerifyTile.tsx')).toMatch(/href=\{tile\.runHref\}/);
  });

  it('traceVerifyDetail uses the in-process verify, read only, and the module keeps the one door', () => {
    const mod = source('composition/ops-controls.ts');
    expect(mod).toMatch(/verifyTrace\(/);
    expect(mod).toMatch(/formatTraceFinding/);
    expect(mod).toMatch(/from '\.\.\/server\/access'/);
    expect(mod).not.toMatch(/composition\.server/);
    expect(mod).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe('OPS-B.5 the verified mark of a timeline (S1)', () => {
  const entry = (seq: number, verified: boolean): TimelineEntryView => ({
    ...TIMELINE_FIXTURES[0]!,
    seq,
    verified,
  });

  it('is "verified" when every entry is verified', () => {
    expect(timelineMark([entry(1, true), entry(2, true), entry(3, true)])).toEqual({
      kind: 'verified',
      text: 'verified',
    });
  });

  it('names the lowest seq that is not verified', () => {
    expect(timelineMark([entry(1, true), entry(9, false), entry(7, false), entry(8, true)])).toEqual({
      kind: 'broken',
      text: 'first broken row at seq 7',
    });
    expect(timelineMark([entry(1, true), entry(7, false), entry(9, false)]).text).toBe(
      'first broken row at seq 7',
    );
  });

  it('draws nothing for an empty timeline, and the fixture world has one unverified row', () => {
    expect(timelineMark([])).toBeNull();
    expect(timelineMark(TIMELINE_FIXTURES).text).toBe('first broken row at seq 6');
  });

  it('is derived from the entries, with no extra call: the component reads timelineMark and nothing fetches', () => {
    const tl = source('ui/Timeline.tsx');
    expect(tl).toMatch(/timelineMark\(/);
    expect(tl).not.toMatch(/fetch\s*\(|getJson|useEffect/);
    expect(source('lib/verify-view.ts')).not.toMatch(/fetch\s*\(|getJson/);
  });
});
