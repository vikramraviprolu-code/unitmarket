// Dry-run scenarios D1 to D6 and the parse-first helpers the conformance cases share (lane 16).
// D1 to D6 are the simulation's S1 to S6 (adapted from AIC_Hackathon_UnitMarket
// packages/testkit/src/conformance.ts at a36ddc03fd0b962000f686291c145b50ee337f90) rewritten as
// scenarios the dry-run transport can play. They need scripted behaviour and never run against the
// sandbox. Expectations come from the verified PayPal facts named per case, not from the adapter.
// Each scenario's call order is the table in fixtures/paypal/README.md; the cases make exactly those
// calls, so a step is never consumed by accident. D2 has no fixture file (see the model in stack.ts).
import { expect } from 'vitest';
import {
  CaptureReadSchema,
  CaptureResSchema,
  CreateOrderResSchema,
  OrderReadSchema,
} from '@umsbx/contracts';
import type {
  CaptureRead,
  CaptureRes,
  CreateOrderReq,
  CreateOrderRes,
  OrderRead,
  PayPalPort,
  ProviderOrderId,
} from '@umsbx/contracts';
import type { ConformanceHooks } from './conformance';

// ---- helpers: each parses the answer with its contracts schema first ----

export const captureKey = (r: CreateOrderReq): string => `${r.request_id}:capture`;

export async function create(
  port: PayPalPort,
  req: CreateOrderReq,
): Promise<{ id: ProviderOrderId; approveUrl: string; status: string }> {
  const res: CreateOrderRes = CreateOrderResSchema.parse(await port.createOrder(req));
  if (res.kind !== 'created') throw new Error(`createOrder returned ${res.kind}`);
  return { id: res.provider_order_id, approveUrl: res.approve_url, status: res.status };
}

export async function read(
  port: PayPalPort,
  id: ProviderOrderId,
): Promise<Extract<OrderRead, { kind: 'order' }>> {
  const res = OrderReadSchema.parse(await port.getOrder(id));
  if (res.kind !== 'order') throw new Error(`getOrder returned ${res.kind}`);
  return res;
}

export async function captureRes(
  port: PayPalPort,
  id: ProviderOrderId,
  request_id: string,
): Promise<CaptureRes> {
  return CaptureResSchema.parse(await port.captureOrder({ provider_order_id: id, request_id }));
}

export async function claim(
  port: PayPalPort,
  id: ProviderOrderId,
  request_id: string,
): Promise<Extract<CaptureRes, { kind: 'claim' }>> {
  const res = await captureRes(port, id, request_id);
  if (res.kind !== 'claim') throw new Error(`captureOrder returned ${res.kind}`);
  return res;
}

export async function readCapture(
  port: PayPalPort,
  capture_id: string,
): Promise<Extract<CaptureRead, { kind: 'capture' }>> {
  const res = CaptureReadSchema.parse(await port.getCapture(capture_id));
  if (res.kind !== 'capture') throw new Error(`getCapture returned ${res.kind}`);
  return res;
}

export async function createApproveCapture(
  port: PayPalPort,
  hooks: ConformanceHooks,
  req: CreateOrderReq,
): Promise<{ id: ProviderOrderId; claim: Extract<CaptureRes, { kind: 'claim' }> }> {
  const { id } = await create(port, req);
  await hooks.approve(id);
  return { id, claim: await claim(port, id, captureKey(req)) };
}

export const byRef = <T extends { reference_id: string }>(units: T[]): T[] =>
  [...units].sort((a, b) => (a.reference_id < b.reference_id ? -1 : 1));
export const captureIds = (units: { reference_id: string; capture_id: string | null }[]) =>
  byRef(units).map((u) => u.capture_id);

export function unitOf<T extends { reference_id: string }>(units: T[], reference_id: string): T {
  const u = units.find((x) => x.reference_id === reference_id);
  if (u === undefined) throw new Error(`no unit with reference_id ${reference_id}`);
  return u;
}

// ---- D1 to D6 ----

export interface ScenarioContext {
  port: PayPalPort;
  hooks: ConformanceHooks;
  request: CreateOrderReq;
}
export interface DryRunScenario {
  id: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
  title: string;
  /** Scenario name the dry-run transport plays. */
  scenario: string;
  run(c: ScenarioContext): Promise<void>;
}

const onlyCapture = (o: Extract<OrderRead, { kind: 'order' }>, ref = 'unit-1') =>
  unitOf(o.units, ref).capture;

export const dryRunScenarios: DryRunScenario[] = [
  {
    // FACT F-PENDING: capture_status PENDING is a valid capture answer (receiving preferences
    // can hold a capture, architecture 12); the same capture id later reads COMPLETED. A PENDING
    // claim is not money: only the read decides.
    id: 'D1',
    title: 'pending then completed',
    scenario: 'pending_then_completed',
    async run({ port, hooks, request }) {
      const { id } = await create(port, request);
      await hooks.approve(id);
      expect((await read(port, id)).status).toBe('APPROVED');
      const c = await claim(port, id, captureKey(request));
      const first = unitOf(c.units, 'unit-1');
      expect(first.status).toBe('PENDING');
      expect(first.capture_id).not.toBeNull();
      const pending = onlyCapture(await read(port, id));
      expect(pending?.status).toBe('PENDING');
      expect(pending?.capture_id).toBe(first.capture_id);
      const done = onlyCapture(await read(port, id));
      expect(done?.status).toBe('COMPLETED');
      expect(done?.capture_id).toBe(first.capture_id);
      expect((await readCapture(port, first.capture_id ?? '')).capture.status).toBe('PENDING');
      expect((await readCapture(port, first.capture_id ?? '')).capture.status).toBe('COMPLETED');
    },
  },
  {
    // FACT F-PENDING + F-DECLINED: capture_status enum has PENDING and DECLINED; a pending
    // capture can end DECLINED and keeps its capture id. A DECLINED read is the only evidence of a
    // decline (architecture 4.2).
    id: 'D2',
    title: 'pending then declined',
    scenario: 'pending_then_declined',
    async run({ port, hooks, request }) {
      const { id } = await create(port, request);
      await hooks.approve(id);
      const c = await claim(port, id, captureKey(request));
      const first = unitOf(c.units, 'unit-1');
      expect(first.status).toBe('PENDING');
      expect(first.capture_id).not.toBeNull();
      expect(onlyCapture(await read(port, id))?.status).toBe('PENDING');
      const after = onlyCapture(await read(port, id));
      expect(after?.status).toBe('DECLINED');
      expect(after?.capture_id).toBe(first.capture_id);
    },
  },
  {
    // FACT F-TIMEOUT: a timeout says nothing about whether PayPal captured (architecture 5, 9.1:
    // "timeout: unknown; read first"). The read shows COMPLETED, and the same key replays the
    // stored answer (F-IDEM) with the same capture id.
    id: 'D3',
    title: 'lost capture response then read COMPLETED',
    scenario: 'lost_capture_response',
    async run({ port, hooks, request }) {
      const { id } = await create(port, request);
      await hooks.approve(id);
      expect((await read(port, id)).status).toBe('APPROVED');
      const lost = await captureRes(port, id, captureKey(request));
      expect(lost.kind).toBe('timeout');
      const after = await read(port, id);
      expect(after.status).toBe('COMPLETED');
      const cap = onlyCapture(after);
      expect(cap?.status).toBe('COMPLETED');
      expect(cap?.capture_id).toBeTruthy();
      const again = await claim(port, id, captureKey(request));
      expect([200, 201]).toContain(again.http);
      expect(unitOf(again.units, 'unit-1').capture_id).toBe(cap?.capture_id);
    },
  },
  {
    // FACT F-202: capture can answer 202 (Orders OpenAPI responses 200, 201, 202, 207): accepted,
    // outcome not yet known. The claim carries no capture; the read afterwards decides.
    id: 'D4',
    title: '202 then read',
    scenario: 'capture_202',
    async run({ port, hooks, request }) {
      const { id } = await create(port, request);
      await hooks.approve(id);
      expect((await read(port, id)).status).toBe('APPROVED');
      const c = await claim(port, id, captureKey(request));
      expect(c.http).toBe(202);
      for (const u of c.units) expect(u.capture_id).toBeNull();
      const after = await read(port, id);
      expect(after.status).toBe('COMPLETED');
      const cap = onlyCapture(after);
      expect(cap?.status).toBe('COMPLETED');
      expect((await readCapture(port, cap?.capture_id ?? '')).capture.status).toBe('COMPLETED');
    },
  },
  {
    // FACT F-207: capture can answer 207 for a multi-unit order, with a status per unit
    // (Orders OpenAPI): one unit COMPLETED and one DECLINED is a partial success, not a failure.
    id: 'D5',
    title: '207 partial',
    scenario: 'partial_207',
    async run({ port, hooks, request }) {
      const unit = request.units[0];
      if (unit === undefined) throw new Error('orderRequest has no unit');
      const two: CreateOrderReq = {
        ...request,
        units: [
          { ...unit, reference_id: 'unit-1', amount: { currency: 'USD', minor: 300 } },
          {
            ...unit,
            reference_id: 'unit-2',
            payee_merchant_id: 'SBXMERCHANT02',
            amount: { currency: 'USD', minor: 200 },
          },
        ],
      };
      const { id } = await create(port, two);
      await hooks.approve(id);
      expect((await read(port, id)).status).toBe('APPROVED');
      const c = await claim(port, id, captureKey(two));
      expect(c.http).toBe(207);
      expect(unitOf(c.units, 'unit-1').status).toBe('COMPLETED');
      expect(unitOf(c.units, 'unit-2').status).toBe('DECLINED');
      const o = await read(port, id);
      expect(onlyCapture(o, 'unit-1')?.status).toBe('COMPLETED');
      expect(onlyCapture(o, 'unit-2')?.status).toBe('DECLINED');
    },
  },
  {
    // FACT F-429: PayPal answers 429 when rate limited (the issue name is UNVERIFIED, architecture
    // 0); the adapter maps it by HTTP class to unavailable with the Retry-After hint in
    // milliseconds, and the same request id then succeeds (F-IDEM).
    id: 'D6',
    title: '429 then success with backoff hint',
    scenario: 'rate_limited_429',
    async run({ port, request }) {
      const first = await port.createOrder(request);
      expect(first.kind).toBe('unavailable');
      if (first.kind === 'unavailable') expect(first.retry_after_ms).toBe(2000);
      const second = await port.createOrder(request);
      expect(CreateOrderResSchema.parse(second).kind).toBe('created');
    },
  },
];
