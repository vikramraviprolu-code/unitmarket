// Adapter conformance suite for PayPalPort (lane 16, architecture 11, nfr MAINT-3).
// Adapted from AIC_Hackathon_UnitMarket packages/testkit/src/conformance.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90 (C1 to C15 structure, parse-first helpers, subject
// shape). Owned by SBX.
//
// P1 to P15 are written from VERIFIED PayPal facts (architecture section 0 and 9.1, the OpenAPI
// files named there, and the docs-example fixtures), never from what the adapter does. Each case
// names its fact in a FACT comment. A case is never edited to make an implementation pass: raise it
// with the reviewer. The portable suite uses only the port, subject.orderRequest() and the hooks,
// so it runs unchanged against the dry-run transport (CI) and the sandbox (owner only, MVP-B).
import { describe, expect, it } from 'vitest';
import { CaptureResSchema, CreateOrderResSchema, OrderReadSchema } from '@umsbx/contracts';
import type { CreateOrderReq, PayPalFail, PayPalPort, ProviderOrderId } from '@umsbx/contracts';
import { SANDBOX_API } from '@umsbx/transport';
import {
  captureIds,
  captureKey,
  captureRes,
  claim,
  create,
  createApproveCapture,
  dryRunScenarios,
  read,
  readCapture,
  unitOf,
} from './scenarios';

export interface ConformanceHooks {
  /**
   * Buyer approval. Dry-run: a state change in the model (the link is ignored). Sandbox (BU-6): writes
   * one line to stderr with the link, then polls GET order until it reads APPROVED. `approve_url` is
   * optional only because the shared scenario helpers call approve(id); the sandbox hook then uses the
   * link the create answer carried.
   */
  approve(provider_order_id: ProviderOrderId, approve_url?: string): Promise<void>;
  /** Dry-run only: choose the scripted scenario for the calls that follow. A no-op elsewhere. */
  scenario(name: string): void;
  /**
   * ASM-16-1: addition to the lane 16 hooks. Every URL a call was addressed to after the egress
   * guard accepted it, in order. P14 and P15 need a transport spy and the port cannot offer one.
   */
  sentUrls(): string[];
}
export interface ConformanceSubject {
  name: string;
  /** A fresh port and hooks per test. */
  make(): Promise<{ port: PayPalPort; hooks: ConformanceHooks }>;
  /** A valid request with a fresh request_id and one or more units. */
  orderRequest(): CreateOrderReq;
}

const SANDBOX_ORIGIN = new URL(SANDBOX_API).origin;
const NOT_FOUND_ID = 'NOSUCHORDER0000001';

function expectRejected(res: { kind: string }, http: number, issue: string): void {
  expect(res.kind).toBe('rejected');
  const f = res as Extract<PayPalFail, { kind: 'rejected' }>;
  expect(f.http).toBe(http);
  expect(f.issue).toBe(issue);
}

// ---- portable suite P1 to P15 ----

export function describePayPalConformance(s: ConformanceSubject): void {
  describe(`PayPal conformance: ${s.name}`, () => {
    // FACT F-CREATE: POST /v2/checkout/orders answers 201 with the order id, a status and an
    // approval link; the buyer is sent to the sandbox approval host (architecture 0, 9.1).
    it('P1 create gives created with an approve URL on the sandbox approval host', async () => {
      const { port } = await s.make();
      const res = CreateOrderResSchema.parse(await port.createOrder(s.orderRequest()));
      expect(res.kind).toBe('created');
      if (res.kind !== 'created') return;
      expect(['CREATED', 'PAYER_ACTION_REQUIRED']).toContain(res.status);
      expect(new URL(res.approve_url).origin).toBe('https://www.sandbox.paypal.com');
    });

    // FACT F-IDEM: PayPal-Request-Id makes a repeated POST return the first answer; keys are
    // stored 6 hours (architecture 0).
    it('P2 the same request id twice gives the same order id', async () => {
      const { port } = await s.make();
      const req = s.orderRequest();
      const first = await create(port, req);
      const second = await create(port, req);
      expect(second.id).toBe(first.id);
    });

    // FACT F-GET-CREATED: GET order before approval has status CREATED (or PAYER_ACTION_REQUIRED
    // after a payer-action create), purchase_units with reference_id and amount, and the
    // custom_id sent on create (OpenAPI purchase_unit; payee echo is UNVERIFIED in architecture
    // 0, so it is only compared when present).
    it('P3 read before approval gives CREATED with units, amounts and custom_id echoed', async () => {
      const { port } = await s.make();
      const req = s.orderRequest();
      const { id } = await create(port, req);
      const o = await read(port, id);
      expect(o.provider_order_id).toBe(id);
      expect(['CREATED', 'PAYER_ACTION_REQUIRED']).toContain(o.status);
      expect(o.custom_id).toBe(req.order_ref);
      expect(o.units).toHaveLength(req.units.length);
      for (const sent of req.units) {
        const got = unitOf(o.units, sent.reference_id);
        expect(got.amount).toEqual(sent.amount);
        if (got.payee_merchant_id !== null) {
          expect(got.payee_merchant_id).toBe(sent.payee_merchant_id);
        }
        expect(got.capture).toBeNull();
      }
    });

    // FACT F-STATUS: order_status enum includes APPROVED once the payer approved.
    it('P4 read after approve gives APPROVED', async () => {
      const { port, hooks } = await s.make();
      const { id, approveUrl } = await create(port, s.orderRequest());
      await hooks.approve(id, approveUrl);
      expect((await read(port, id)).status).toBe('APPROVED');
    });

    // FACT F-CAPTURE-OK: capture of an approved order answers 200 or 201 with one capture per
    // unit; capture_status COMPLETED (Orders OpenAPI capture responses; architecture 3 step 12).
    it('P5 capture gives a claim with COMPLETED units and capture ids', async () => {
      const { port, hooks } = await s.make();
      const req = s.orderRequest();
      const { id, claim: c } = await createApproveCapture(port, hooks, req);
      expect(c.provider_order_id).toBe(id);
      expect([200, 201]).toContain(c.http);
      expect(c.units).toHaveLength(req.units.length);
      for (const sent of req.units) {
        const got = unitOf(c.units, sent.reference_id);
        expect(got.status).toBe('COMPLETED');
        expect(got.capture_id).not.toBeNull();
      }
      expect(new Set(c.units.map((u) => u.capture_id)).size).toBe(c.units.length);
    });

    // FACT F-IDEM + F-ONE-CAPTURE: the same PayPal-Request-Id replays the first capture answer;
    // intent=CAPTURE allows one capture per order, so the capture ids cannot change.
    it('P6 capture again with the same key gives the same capture ids', async () => {
      const { port, hooks } = await s.make();
      const req = s.orderRequest();
      const { id, claim: first } = await createApproveCapture(port, hooks, req);
      const again = await claim(port, id, captureKey(req));
      expect(captureIds(again.units)).toEqual(captureIds(first.units));
    });

    // FACT F-ALREADY: capture 422 issue ORDER_ALREADY_CAPTURED, "If intent=CAPTURE only one
    // capture per order is allowed" (docs_capture_422_order_already_captured, orders-errors.md).
    it('P7 capture with a new key after capture is rejected ORDER_ALREADY_CAPTURED', async () => {
      const { port, hooks } = await s.make();
      const req = s.orderRequest();
      const { id } = await createApproveCapture(port, hooks, req);
      const res = await captureRes(port, id, `${req.request_id}:second`);
      expectRejected(res, 422, 'ORDER_ALREADY_CAPTURED');
    });

    // FACT F-GET-COMPLETED: GET order after capture is COMPLETED and lists the captures; read
    // time is UTC with Z (adapter stamps it; contracts IsoUtc).
    it('P8 read after capture gives COMPLETED with matching capture ids and read_at in UTC with Z', async () => {
      const { port, hooks } = await s.make();
      const req = s.orderRequest();
      const { id, claim: c } = await createApproveCapture(port, hooks, req);
      const o = await read(port, id);
      expect(o.status).toBe('COMPLETED');
      expect(o.read_at).toMatch(/Z$/);
      expect(Number.isNaN(Date.parse(o.read_at))).toBe(false);
      for (const u of o.units) {
        expect(u.capture?.status).toBe('COMPLETED');
        expect(u.capture?.capture_id).toBe(unitOf(c.units, u.reference_id).capture_id);
      }
    });

    // FACT F-404: GET order for an id that does not exist answers 404 RESOURCE_NOT_FOUND
    // (docs_get_order_404); absence is not a failure.
    it('P9 an unknown order id gives not_found', async () => {
      const { port } = await s.make();
      const res = OrderReadSchema.parse(await port.getOrder(NOT_FOUND_ID));
      expect(res.kind).toBe('not_found');
    });

    // FACT F-NOT-APPROVED: capture 422 issue ORDER_NOT_APPROVED, "Payer has not yet approved the
    // Order for payment" (docs_capture_422_order_not_approved, orders-errors.md).
    it('P10 capture before approval is rejected ORDER_NOT_APPROVED', async () => {
      const { port } = await s.make();
      const req = s.orderRequest();
      const { id } = await create(port, req);
      expectRejected(await captureRes(port, id, captureKey(req)), 422, 'ORDER_NOT_APPROVED');
      // Nothing changed: the order is still not captured.
      expect((await read(port, id)).status).not.toBe('COMPLETED');
    });

    // FACT F-SCHEMA: every answer is one contracts shape, and the port names its environment
    // (architecture 6: dry run or sandbox, never implied).
    it('P11 every result parses with its contracts schema and carries the environment', async () => {
      const { port, hooks } = await s.make();
      expect(['dryrun', 'sandbox']).toContain(port.environment);
      const req = s.orderRequest();
      CreateOrderResSchema.parse(await port.createOrder(req));
      const { id, approveUrl } = await create(port, req);
      OrderReadSchema.parse(await port.getOrder(id));
      OrderReadSchema.parse(await port.getOrder(NOT_FOUND_ID));
      await hooks.approve(id, approveUrl);
      const c = await claim(port, id, captureKey(req));
      for (const u of c.units) {
        if (u.capture_id !== null) await readCapture(port, u.capture_id);
      }
      CaptureResSchema.parse(await port.captureOrder({ provider_order_id: id, request_id: 'k2' }));
    });

    // FACT F-DECIMAL: PayPal amounts are decimal strings; the minor-unit integer must come back
    // exactly (no float drift) for 1 cent, 99 cents and values with a trailing zero.
    it('P12 amounts round-trip exactly', async () => {
      const { port, hooks } = await s.make();
      const base = s.orderRequest();
      const minors = [1, 99, 1001, 12345, 500];
      const req: CreateOrderReq = {
        ...base,
        units: base.units.map((u, i) => ({
          ...u,
          amount: { ...u.amount, minor: minors[i % minors.length] ?? 1 },
        })),
      };
      const { id, approveUrl } = await create(port, req);
      const o = await read(port, id);
      for (const sent of req.units) {
        expect(unitOf(o.units, sent.reference_id).amount).toEqual(sent.amount);
      }
      await hooks.approve(id, approveUrl);
      const c = await claim(port, id, captureKey(req));
      for (const sent of req.units) {
        const cap = unitOf(c.units, sent.reference_id).capture_id;
        expect(cap).not.toBeNull();
        expect((await readCapture(port, cap ?? '')).amount).toEqual(sent.amount);
      }
    });

    // FACT F-ONE-CURRENCY: PayPal refuses MULTI_CURRENCY_ORDER (architecture 12); an order read
    // therefore has one currency, the one requested.
    it('P13 one currency per read', async () => {
      const { port, hooks } = await s.make();
      const req = s.orderRequest();
      const want = req.units[0]?.amount.currency;
      const { id, approveUrl } = await create(port, req);
      for (const phase of ['created', 'captured']) {
        if (phase === 'captured') {
          await hooks.approve(id, approveUrl);
          await claim(port, id, captureKey(req));
        }
        const o = await read(port, id);
        expect(new Set(o.units.map((u) => u.amount.currency))).toEqual(new Set([want]));
      }
    });

    // FACT F-108: PayPal-Request-Id has a maximum of 108 characters (architecture 0). A longer id
    // is refused locally: no call leaves.
    it('P14 a request id over 108 characters is refused before sending', async () => {
      const { port, hooks } = await s.make();
      const before = hooks.sentUrls().length;
      const req = { ...s.orderRequest(), request_id: 'r'.repeat(109) };
      const res = await port.createOrder(req);
      expect(res.kind).toBe('rejected');
      expect(hooks.sentUrls().length).toBe(before);
      const ok = await port.createOrder({ ...s.orderRequest(), request_id: 'r'.repeat(108) });
      expect(ok.kind).toBe('created');
    });

    // FACT F-HOST: the API base URL is the sandbox constant and nothing else (nfr P15,
    // architecture 7): after a whole journey every call went to that origin over https.
    it('P15 no call leaves for a host other than the sandbox constant', async () => {
      const { port, hooks } = await s.make();
      const req = s.orderRequest();
      const { id } = await createApproveCapture(port, hooks, req);
      await read(port, id);
      await port.getOrder(NOT_FOUND_ID);
      const urls = hooks.sentUrls();
      expect(urls.length).toBeGreaterThanOrEqual(4);
      for (const u of urls) {
        expect(new URL(u).origin).toBe(SANDBOX_ORIGIN);
        expect(u.startsWith('https://')).toBe(true);
      }
    });
  });
}

// ---- dry-run only: D1 to D6 (scenarios.ts) ----

export function describeDryRunOnly(s: ConformanceSubject): void {
  describe(`dry-run scenarios: ${s.name}`, () => {
    for (const sc of dryRunScenarios) {
      it(`${sc.id} ${sc.title}`, async () => {
        const { port, hooks } = await s.make();
        hooks.scenario(sc.scenario);
        await sc.run({ port, hooks, request: s.orderRequest() });
      });
    }
  });
}
