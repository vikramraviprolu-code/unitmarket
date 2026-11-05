// INT-GA / GA.4 through the real route and the real app: GET /api/ops/orders/[ref]/explain, and the panel on the
// operator order page. The model port (App.model) gets only the identity-free projection, even for an operator with
// the second factor: no source id, actor id, buyer name, provider id or tail, amount or ref. The action is always a
// catalogue fix id or none (a new id becomes none); injected HTML stays text; long text is cut at 400. The one button
// is a link to the catalogue entry's fix.route#anchor and the panel holds no form and no POST. The panel shows only
// when the order's status group is attention. Buyer and seller sessions are refused. Nothing of it is logged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { Actor, ModelRequest, TraceContext } from '@umsbx/contracts';
import { bootA } from './api-v1/a-support';
import type { ARig, Sess } from './api-v1/a-support';
import { HARBOUR_FERRY, HARBOUR_TIDE, QUAY_MARKET, runPack } from './composite-support';
import { call } from './support';
import { explainPanelView } from './lib/explain-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ctx: TraceContext = {
  id: 'ctx_ga_explain',
  at: '2026-11-05T10:00:00.000Z',
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
  job: 'ga_test',
  tool: null,
};

const lines: string[] = [];
let rig: ARig;
let route: typeof import('./app/api/ops/orders/[ref]/explain/route');
let money: typeof import('./composition/ops-money');
let op: Sess;
let noMfa: Sess;
let buyer: Sess;
let seller: Sess;
let attentionRef = '';
let paidRef = '';
const secrets: string[] = [];
const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };

beforeAll(async () => {
  rig = await bootA({}, { log_sink: (l: string) => void lines.push(l) });
  route = await import('./app/api/ops/orders/[ref]/explain/route');
  money = await import('./composition/ops-money');
  op = await rig.session(MFA);
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_demo', mfa: false });
  buyer = await rig.session(rig.buyerA);
  seller = await rig.session(rig.harbour);
  const a = await runPack(rig.app, rig.buyerA, [HARBOUR_TIDE, QUAY_MARKET], ['happy']);
  const b = await runPack(rig.app, rig.buyerA, [HARBOUR_FERRY], ['happy']);
  attentionRef = a.order_ref;
  paidRef = b.order_ref;
  const q = <T extends Record<string, unknown>>(s: string, p: unknown[] = []) =>
    rig.app.db.query<T>(s, p);
  await withTraceContext(ctx, async () => {
    await q(`UPDATE orders SET status = 'unresolved' WHERE id = $1`, [a.order_id]);
    await q(
      `INSERT INTO alerts (id, kind, order_id, detail, created_at, updated_at)
       VALUES ('alr_ga_1', 'payment_unresolved', $1, '{"reason":"ga test"}'::jsonb, now(), now())`,
      [a.order_id],
    );
  });
  const ids = await q<{ v: string | null }>(
    `SELECT capture_id AS v FROM order_units WHERE order_id = $1
     UNION ALL SELECT provider_order_id FROM provider_orders WHERE order_id = $1
     UNION ALL SELECT id FROM order_units WHERE order_id = $1
     UNION ALL SELECT b.display_name FROM buyers b JOIN orders o ON o.buyer_id = b.id WHERE o.id = $1
     UNION ALL SELECT buyer_id FROM orders WHERE id = $1
     UNION ALL SELECT total_minor::text FROM orders WHERE id = $1`,
    [a.order_id],
  );
  for (const r of ids.rows) if (r.v !== null) secrets.push(r.v);
  secrets.push(attentionRef, a.order_id);
});
afterAll(async () => rig?.app.close());

const get = (s: Sess | null, ref: string) =>
  call(route.GET, { url: `/api/ops/orders/${ref}/explain`, session: s, params: { ref } });
interface Explained {
  explain: {
    what_happened: string;
    safe_now: string;
    action_id: string;
    button: { href: string; label: string } | null;
  } | null;
}
const read = async (s: Sess, ref: string): Promise<Explained> => {
  const r = await get(s, ref);
  expect(r.status).toBe(200);
  return (await r.json()) as Explained;
};

describe('the port request is the projection only, on an MFA session too', () => {
  it('there are ids, names and amounts that must not leave', () => {
    expect(secrets.length).toBeGreaterThanOrEqual(6);
  });

  it.each([
    ['with the second factor', () => op],
    ['without it', () => noMfa],
  ])(
    '%s: a deep scan finds only the seven entry fields, alert kinds and fix ids',
    async (_n, who) => {
      const spy = vi.spyOn(rig.app.model, 'complete');
      await read(who(), attentionRef);
      expect(spy).toHaveBeenCalledTimes(1);
      const req = spy.mock.calls[0]![0] as ModelRequest;
      expect(req.purpose).toBe('explain_order');
      const keys = new Set<string>();
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === 'object' && v !== null)
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
      };
      walk(req.input);
      expect([...keys].sort()).toEqual(
        [
          'entries',
          'alert_kinds',
          'fix_ids',
          'seq',
          'event_type',
          'words_key',
          'actor_kind',
          'channel',
          'state_from',
          'state_to',
        ].sort(),
      );
      const sent = JSON.stringify(req);
      for (const s of secrets) expect(sent, s).not.toContain(s);
      expect((req.input as { alert_kinds: string[] }).alert_kinds).toEqual(['payment_unresolved']);
      spy.mockRestore();
    },
  );
});

describe('the answer', () => {
  const inject = (output: unknown) =>
    vi
      .spyOn(rig.app.model, 'complete')
      .mockResolvedValue({ kind: 'ok', output, input_tokens: 0, output_tokens: 0 });

  it('scripted: the action is the alert on the order, and the button links to its fix page', async () => {
    const e = (await read(op, attentionRef)).explain!;
    expect(e.action_id).toBe('payment_unresolved');
    expect(e.button).toEqual({ href: '/ops/money#ops-orders', label: expect.any(String) });
  });

  it('an injected answer with a new id becomes none, with no button', async () => {
    const spy = inject({ what_happened: 'x', safe_now: 'y', action_id: 'refund_all_now' });
    const e = (await read(op, attentionRef)).explain!;
    expect(e.action_id).toBe('none');
    expect(e.button).toBeNull();
    spy.mockRestore();
  });

  it('injected HTML is answered as text, and over-long text is cut at 400', async () => {
    const html = '<script>alert(1)</script>';
    const spy = inject({
      what_happened: html + 'a'.repeat(900),
      safe_now: 'b'.repeat(500),
      action_id: 'none',
    });
    const e = (await read(op, attentionRef)).explain!;
    expect(e.what_happened.startsWith(html)).toBe(true);
    expect(e.what_happened).toHaveLength(400);
    expect(e.safe_now).toHaveLength(400);
    spy.mockRestore();
  });

  it('an order that is not in attention has no panel, and the model is not asked', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete');
    expect((await read(op, paidRef)).explain).toBeNull();
    expect(await money.readOrderExplain(MFA, paidRef)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an unknown order is 404', async () => {
    expect((await get(op, 'ord_doesnotexist')).status).toBe(404);
  });
});

describe('who may ask', () => {
  it('buyer and seller sessions are refused, and no session is 401', async () => {
    expect((await get(buyer, attentionRef)).status).toBe(403);
    expect((await get(seller, attentionRef)).status).toBe(403);
    expect((await get(null, attentionRef)).status).toBe(401);
  });

  it('the text is not logged', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete').mockResolvedValue({
      kind: 'ok',
      output: { what_happened: 'okapicanary', safe_now: 'tapircanary', action_id: 'none' },
      input_tokens: 0,
      output_tokens: 0,
    });
    await read(op, attentionRef);
    spy.mockRestore();
    const all = lines.join('\n');
    expect(all).not.toContain('okapicanary');
    expect(all).not.toContain('tapircanary');
  });
});

describe('the panel and the page, read as text', () => {
  const panel = source('ui/ExplainPanel.tsx');
  const page = source('app/ops/money/orders/[ref]/page.tsx');

  it('the panel has no form, no POST, no fetch and no raw HTML', () => {
    expect(panel).not.toMatch(/<form|method=|postJson|fetch\(|dangerouslySetInnerHTML|innerHTML/);
  });
  it('the one button is a link built by the view', () => {
    expect(panel).toMatch(/<Link[^>]*href=\{view\.button\.href\}/);
    expect(panel).not.toMatch(/<button/);
  });
  it('the page shows the panel only when the composition gives one (attention only)', () => {
    expect(page).toMatch(/readOrderExplain\(/);
    expect(page).toMatch(/explain !== null \?/);
    expect(page).toMatch(/from '(\.\.\/)+composition\/ops-money'/);
  });
  it('the view: the href goes through next-path, a bad route or anchor gives no button, text is cut', () => {
    const fixes = { frozen_order: { route: '/ops/money', anchor: 'ops-orders' } };
    expect(
      explainPanelView({ what_happened: 'a', safe_now: 'b', action_id: 'frozen_order' }, fixes)
        .button?.href,
    ).toBe('/ops/money#ops-orders');
    expect(
      explainPanelView(
        { what_happened: 'a', safe_now: 'b', action_id: 'frozen_order' },
        {
          frozen_order: { route: '//evil.example', anchor: 'x' },
        },
      ).button,
    ).toBeNull();
    expect(
      explainPanelView(
        { what_happened: 'a', safe_now: 'b', action_id: 'frozen_order' },
        {
          frozen_order: { route: '/ops/money', anchor: 'x" onclick="y' },
        },
      ).button,
    ).toBeNull();
    expect(
      explainPanelView({ what_happened: 'a', safe_now: 'b', action_id: 'none' }, fixes).button,
    ).toBeNull();
    expect(
      explainPanelView({ what_happened: 'z'.repeat(500), safe_now: 'b', action_id: 'none' }, fixes)
        .what_happened,
    ).toHaveLength(400);
  });
});
