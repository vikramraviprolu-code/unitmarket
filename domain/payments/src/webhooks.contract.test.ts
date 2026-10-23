// CO-2 contract: the surface the webhook route (CO-3) calls and the tables it relies on keep their
// shape. Type-level checks (expectTypeOf, run by tsc in the typecheck step) plus runtime pins of
// the event-type to target table, the verdict to HTTP table and the webhook_events columns.
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { ProviderEventTypeSchema, WebhookVerdictSchema } from '@umsbx/contracts';
import type {
  CoreDeps,
  IsoUtc,
  ProviderEvent,
  ProviderEventType,
  WebhookVerdict,
} from '@umsbx/contracts';
import * as api from './index';
import { handleWebhook } from './index';
import type { AlertKind, WebhookInput, WebhookResponse } from './index';
import { makeWorld, paid } from './ops/support';
import type { OpsWorld } from './ops/support';
import { COALESCE_MS, idsAreValid, targetsOf } from './webhooks';
import type { Target } from './webhooks';

let w: OpsWorld;
afterEach(async () => {
  await w?.close();
});

describe('handleWebhook: types', () => {
  it('WebhookInput is the verdict, the received transmission id and the arrival time', () => {
    expectTypeOf<WebhookInput>().toEqualTypeOf<{
      verdict: WebhookVerdict;
      transmission_id: string;
      received_at: IsoUtc;
    }>();
  });

  it('WebhookResponse is a status of 200, 400 or 503 and one of six outcomes', () => {
    expectTypeOf<WebhookResponse['http']>().toEqualTypeOf<200 | 400 | 503>();
    expectTypeOf<WebhookResponse['outcome']>().toEqualTypeOf<
      'enqueued' | 'no_op' | 'duplicate' | 'rejected' | 'unverifiable' | 'disabled'
    >();
  });

  it('handleWebhook takes the core deps (never PayPal) and answers a promise of the response', () => {
    expectTypeOf(handleWebhook).parameter(0).toEqualTypeOf<CoreDeps>();
    expectTypeOf(handleWebhook).parameter(1).toEqualTypeOf<WebhookInput>();
    expectTypeOf(handleWebhook).returns.toEqualTypeOf<Promise<WebhookResponse>>();
    expect(handleWebhook.length).toBe(2);
  });

  it('the payments package exports handleWebhook next to the rest', () => {
    expect(typeof api.handleWebhook).toBe('function');
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['suspectReversal', 'runDue']));
  });

  it('targetsOf answers the keys to try, in order; idsAreValid answers a boolean', () => {
    expectTypeOf(targetsOf).parameter(0).toEqualTypeOf<ProviderEvent>();
    expectTypeOf(targetsOf).returns.toEqualTypeOf<NonNullable<Target>[]>();
    expectTypeOf(idsAreValid).parameter(0).toEqualTypeOf<ProviderEvent>();
    expectTypeOf(idsAreValid).returns.toEqualTypeOf<boolean>();
    expect(COALESCE_MS).toBe(60_000);
  });
});

describe('alert kinds', () => {
  it('the REVERSED hint has its own kind, which recovery does not turn into a case', () => {
    expectTypeOf<'reversal_hint'>().toExtend<AlertKind>();
    expectTypeOf<'reversal'>().toExtend<AlertKind>();
  });
});

describe('the verdicts the verifier (CO-1) hands over', () => {
  it('are exactly four kinds', () => {
    const kinds = WebhookVerdictSchema.options.map((o) => o.shape.kind.value).sort();
    expect(kinds).toEqual(['bad_signature', 'malformed', 'unverifiable', 'verified']);
  });
  it('the event types are the nine the target table covers', () => {
    expect(ProviderEventTypeSchema.options).toEqual([
      'PAYMENT.CAPTURE.COMPLETED',
      'PAYMENT.CAPTURE.PENDING',
      'PAYMENT.CAPTURE.DECLINED',
      'PAYMENT.CAPTURE.DENIED',
      'PAYMENT.CAPTURE.REFUNDED',
      'PAYMENT.CAPTURE.REVERSED',
      'CHECKOUT.ORDER.APPROVED',
      'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
      'OTHER',
    ]);
  });
});

describe('event type to target (pinned)', () => {
  // Exhaustive by construction: the Record needs a key for every event type.
  const BY: Record<ProviderEventType, 'capture_id' | 'provider_order_id' | null> = {
    'PAYMENT.CAPTURE.COMPLETED': 'capture_id',
    'PAYMENT.CAPTURE.PENDING': 'capture_id',
    'PAYMENT.CAPTURE.DECLINED': 'capture_id',
    'PAYMENT.CAPTURE.DENIED': 'capture_id',
    'PAYMENT.CAPTURE.REFUNDED': 'capture_id',
    'PAYMENT.CAPTURE.REVERSED': 'capture_id',
    'CHECKOUT.ORDER.APPROVED': 'provider_order_id',
    'CHECKOUT.PAYMENT-APPROVAL.REVERSED': 'provider_order_id',
    OTHER: null,
  };
  it.each(Object.entries(BY))('%s names its order first by %s', (type, by) => {
    const e: ProviderEvent = {
      event_id: 'E1',
      transmission_id: 'T1',
      type: type as ProviderEventType,
      provider_order_id: 'ORD1',
      capture_id: 'CAP1',
      refund_id: 'REF1',
      occurred_at: '2026-10-22T10:00:00.000Z',
    };
    const t = targetsOf(e)[0] ?? null;
    expect(t === null ? null : t.by).toBe(by);
    expect(t === null ? null : t.key).toBe(
      by === 'capture_id' ? 'CAP1' : by === 'provider_order_id' ? 'ORD1' : null,
    );
  });
});

describe('verdict to HTTP status (pinned)', () => {
  const ev = (n: number, capture_id: string | null): ProviderEvent => ({
    event_id: `WH-CON-${n}`,
    transmission_id: `tx-con-${n}`,
    type: 'PAYMENT.CAPTURE.COMPLETED',
    provider_order_id: null,
    capture_id,
    refund_id: null,
    occurred_at: '2026-10-22T10:00:00.000Z',
  });
  const table: [string, WebhookVerdict, WebhookResponse][] = [
    [
      'verified (stored)',
      { kind: 'verified', event: ev(1, 'NOTOURS1') },
      { http: 200, outcome: 'no_op' },
    ],
    [
      'bad_signature',
      { kind: 'bad_signature', why: 'signature' },
      { http: 400, outcome: 'rejected' },
    ],
    ['malformed', { kind: 'malformed' }, { http: 400, outcome: 'rejected' }],
    ['unverifiable', { kind: 'unverifiable' }, { http: 503, outcome: 'unverifiable' }],
  ];

  it.each(table)('%s with the switch on', async (_name, verdict, expected) => {
    w = await makeWorld();
    const r = await handleWebhook(w.deps, {
      verdict,
      transmission_id: 'tx-con',
      received_at: w.clock.now().toISOString(),
    });
    expect(r).toEqual(expected);
  });

  it.each(table)('%s with the switch off answers 503 disabled', async (_name, verdict) => {
    w = await makeWorld();
    w.switches.webhook_enabled = false;
    const r = await handleWebhook(w.deps, {
      verdict,
      transmission_id: 'tx-con',
      received_at: w.clock.now().toISOString(),
    });
    expect(r).toEqual({ http: 503, outcome: 'disabled' });
  });

  it('a verified event seen before answers 200 duplicate', async () => {
    w = await makeWorld();
    const verdict: WebhookVerdict = { kind: 'verified', event: ev(2, null) };
    const input = {
      verdict,
      transmission_id: 'tx-con-2',
      received_at: w.clock.now().toISOString(),
    };
    expect(await handleWebhook(w.deps, input)).toEqual({ http: 200, outcome: 'no_op' });
    expect(await handleWebhook(w.deps, input)).toEqual({ http: 200, outcome: 'duplicate' });
  });
});

describe('what intake reads and writes', () => {
  it('webhook_events has exactly the columns intake writes, event and transmission id unique', async () => {
    w = await makeWorld();
    const cols = await w.rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'webhook_events' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'applied_at',
      'created_at',
      'environment',
      'event_id',
      'id',
      'outcome',
      'received_at',
      'resource',
      'transmission_id',
      'type',
      'updated_at',
      'verified',
    ]);
    const unique = await w.rows<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'webhook_events' AND indexdef LIKE '%UNIQUE%' ORDER BY indexdef",
    );
    expect(unique.map((u) => u.indexdef.replace(/^.*\(/, '('))).toEqual([
      '(event_id)',
      '(id)', // the primary key
      '(transmission_id)',
    ]);
  });

  it('a stored event has exactly these fields and the resource holds ids only', async () => {
    w = await makeWorld();
    const a = await paid(w);
    const capture_id = (
      await w.rows<{ capture_id: string }>(
        'SELECT capture_id FROM order_units WHERE order_id = $1',
        [a.order_id],
      )
    )[0]!.capture_id;
    await handleWebhook(w.deps, {
      verdict: { kind: 'verified', event: { ...ev0(), capture_id } },
      transmission_id: 'tx-con-3',
      received_at: '2026-10-22T10:00:05.000Z',
    });
    const [row] = await w.rows<Record<string, unknown>>('SELECT * FROM webhook_events');
    expect(Object.keys(row!).sort()).toEqual([
      'applied_at',
      'created_at',
      'environment',
      'event_id',
      'id',
      'outcome',
      'received_at',
      'resource',
      'transmission_id',
      'type',
      'updated_at',
      'verified',
    ]);
    expect(row).toMatchObject({
      event_id: 'WH-CON-0',
      transmission_id: 'tx-con-0',
      type: 'PAYMENT.CAPTURE.COMPLETED',
      verified: true,
      outcome: 'enqueued',
      applied_at: null,
      environment: 'dryrun',
    });
    expect((row!['received_at'] as Date).toISOString()).toBe('2026-10-22T10:00:05.000Z');
    expect(Object.keys(row!['resource'] as object).sort()).toEqual([
      'capture_id',
      'occurred_at',
      'provider_order_id',
      'refund_id',
    ]);
  });
});

const ev0 = (): ProviderEvent => ({
  event_id: 'WH-CON-0',
  transmission_id: 'tx-con-0',
  type: 'PAYMENT.CAPTURE.COMPLETED',
  provider_order_id: null,
  capture_id: null,
  refund_id: null,
  occurred_at: '2026-10-22T10:00:00.000Z',
});
