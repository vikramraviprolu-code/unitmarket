// BU-6b: a whole fake owner run, then the bytes the run script writes as calls.json. Every
// transport here is a double; ids, names and addresses are invented. Nothing reaches PayPal.
// Simulation tests prove the modelled cases only, not PayPal compatibility.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeSecret } from '@umsbx/config';
import { buildRecordings } from '@umsbx/transport';
import type { Clock, OutboundRequest, Transport, TransportResult } from '@umsbx/contracts';
import {
  createDryRunStack,
  fakeClock,
  ownerSubset,
  renderOwnerSummary,
  sandboxSubject,
} from './index';
import { renderCallsJson } from './sandbox-subject';

const OWN = 'FAKEOWNMERCH7K3Q';
const ACCT = 'FAKEACCTMERCH9Z2X';
const NOW = '2026-11-02T08:30:00.000Z';
const clock = (): Clock => fakeClock(NOW as never);
const TOKEN_ANSWER: TransportResult = {
  kind: 'response',
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ access_token: 'fake-access-token-value-0001', expires_in: 32400 }),
  duration_ms: 1,
};

type Rewrite = (r: OutboundRequest, body: Record<string, unknown>) => void;

/** A sandbox-kind transport over the order model; `rewrite` edits each parsed JSON answer. */
async function fakeRun(o: { rewrite?: Rewrite; stackOwn?: string } = {}) {
  const c = clock();
  const stack = await createDryRunStack({
    clock: c,
    default_scenario: null,
    own_merchant_id: o.stackOwn ?? OWN,
  });
  const created: string[] = [];
  const transport: Transport = {
    kind: 'sandbox',
    async send(r) {
      if (r.operation === 'oauth_token') return TOKEN_ANSWER;
      const res = await stack.transport.send(r);
      if (res.kind !== 'response') return res;
      const body = JSON.parse(res.body) as Record<string, unknown>;
      if (r.operation === 'create_order' && typeof body.id === 'string') created.push(body.id);
      // What a real answer adds: the payee's email and, after approval, a payer block.
      const units = body.purchase_units;
      if (Array.isArray(units))
        for (const u of units as Record<string, Record<string, unknown>>[])
          u.payee = { email_address: 'seller.fake@example.invalid', ...(u.payee ?? {}) };
      if (body.status === 'COMPLETED')
        body.payer = {
          email_address: 'buyer.fake@example.invalid',
          payer_id: 'FAKEPAYERID0001',
          name: { given_name: 'Pat', surname: 'Doe' },
        };
      o.rewrite?.(r, body);
      return { ...res, body: JSON.stringify(body) };
    },
  };
  const lines: string[] = [];
  const subject = sandboxSubject({
    transport,
    clock: c,
    credentials: {
      client_id: makeSecret('fake-client-id-0001'),
      client_secret: makeSecret('fake-client-secret-0001'),
    },
    own_merchant_id: OWN,
    stderr: (l) => lines.push(l),
    sleep: async () => {
      for (const id of created) stack.approve(id);
    },
  });
  const report = await ownerSubset(subject).runAll();
  return { subject, report, lines, created };
}

/** The create answer names the app account's own id (not UMS_OWN_MERCHANT_ID); reads name OWN. */
const echoesAccount: Rewrite = (r, body) => {
  if (r.operation !== 'create_order') return;
  const units = body.purchase_units ?? [{}];
  body.purchase_units = (units as Record<string, Record<string, unknown>>[]).map((u) => ({
    ...u,
    payee: { ...(u.payee ?? {}), merchant_id: ACCT },
  }));
};

describe('a full fake run writes a calls.json that is safe to share', () => {
  it('whole-run baseline: every case passes and the payee echo is own id', async () => {
    const { report } = await fakeRun();
    expect(report.stopped).toBeNull();
    expect(report.cases.every((x) => x.pass)).toBe(true);
    expect(report.payee_echo).toBe('own id');
  });

  it('holds none of the merchant ids but their last 4, no token value, no Authorization value', async () => {
    const { subject, lines } = await fakeRun({ rewrite: echoesAccount });
    const text = renderCallsJson(subject.callLog());
    expect(subject.callLog().length).toBeGreaterThan(8);
    expect(text).not.toContain(OWN);
    expect(text).not.toContain(ACCT);
    expect(text).not.toContain('FAKEACCTMERCH');
    expect(text).not.toContain('FAKEOWNMERCH');
    expect(text).toContain('MERCHANT-REDACTED-9Z2X');
    expect(text).not.toMatch(/token=(?!<redacted>)/i);
    expect(text).toContain('checkoutnow?token=<redacted>');
    expect(text).not.toMatch(/Bearer\s+\S/);
    expect(text).not.toMatch(/Basic\s+[A-Za-z0-9+/=]{6,}/);
    for (const v of [
      'fake-access-token-value-0001',
      'fake-client-id-0001',
      'fake-client-secret-0001',
      'seller.fake',
      'buyer.fake',
      'FAKEPAYERID0001',
      'Pat',
      'Doe',
    ])
      expect(text, v).not.toContain(v);
    for (const e of subject.callLog())
      expect(e.request.headers['authorization'] ?? '[redacted]').toBe('[redacted]');
    // The approval link on the owner's own screen is untouched: the owner needs it.
    expect(lines.some((l) => /checkoutnow\?token=[^<]/.test(l))).toBe(true);
  });

  it('the payee echo compares the live answer: PASS with a masked file, STOP when the live id differs', async () => {
    const pass = await fakeRun({ rewrite: echoesAccount });
    // The created answer carried another id; the check reads the live order read, which names OWN.
    expect(pass.report.payee_echo).toBe('own id');
    expect(pass.report.cases[0]?.pass).toBe(true);
    expect(pass.lines).toContain('payee echo: own id');
    expect(renderCallsJson(pass.subject.callLog())).not.toContain(OWN);

    const stop = await fakeRun({
      rewrite: (r, body) => {
        if (r.operation !== 'get_order') return;
        const units = body.purchase_units;
        if (Array.isArray(units))
          for (const u of units as Record<string, Record<string, unknown>>[])
            u.payee = { ...(u.payee ?? {}), merchant_id: ACCT };
      },
    });
    expect(stop.report.payee_echo).toBe('STOP');
    expect(stop.report.cases[0]?.detail).toMatch(/another payee/);
    expect(stop.lines).toContain('payee echo: STOP');
    expect(renderCallsJson(stop.subject.callLog())).not.toContain(ACCT);
  });

  it('keeps what the fixture recorder needs: order and capture ids, statuses, debug ids', async () => {
    const { subject, created } = await fakeRun({ rewrite: echoesAccount });
    const text = renderCallsJson(subject.callLog());
    for (const id of created) expect(text).toContain(id);
    expect(text).toContain('"status": "COMPLETED"');
    expect(text).toContain('paypal-debug-id');
    const built = await buildRecordings(JSON.parse(text) as never, {
      recorded_at: NOW,
      origin: 'sandbox-recording: BU-6b offline rehearsal against the order model',
    });
    expect(built.ok ? 'ok' : JSON.stringify(built.refusal)).toBe('ok');
  });

  it('summary.md stays clean: ids cut to 6 characters, no merchant id', async () => {
    const { report, created } = await fakeRun({ rewrite: echoesAccount });
    const md = renderOwnerSummary(report, { date: '2026-11-02' });
    expect(md).not.toContain(OWN);
    expect(md).not.toContain(ACCT);
    for (const id of created) expect(md).not.toContain(id);
  });

  it('is byte-identical when redacted twice (the recorder input does not drift)', async () => {
    const { subject } = await fakeRun({ rewrite: echoesAccount });
    const once = JSON.parse(renderCallsJson(subject.callLog())) as unknown;
    expect(JSON.parse(renderCallsJson(once as never))).toEqual(once);
  });
});

describe('the run script writes the log through renderCallsJson', () => {
  const src = readFileSync(
    new URL('../../../scripts/lib/sandbox-conformance-run.mjs', import.meta.url),
    'utf8',
  );
  it('imports it from the testkit and uses it for calls.json', () => {
    expect(src).toMatch(
      /renderCallsJson[\s\S]*from '..\/..\/packages\/testkit\/src\/sandbox-subject\.ts'/,
    );
    expect(src).toMatch(/join\(dir, 'calls\.json'\), renderCallsJson\(exchanges\)/);
    expect(src).not.toMatch(/JSON\.stringify\(exchanges/);
  });
});
