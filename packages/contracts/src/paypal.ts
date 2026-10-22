// PayPal port: shapes the adapter returns to payments core. Verified enums from architecture 9.1.
import { z } from 'zod';
import { BlockReasonSchema } from './transport';
import { IdSchema, IsoUtcSchema, MinorUnitsSchema, MoneySchema } from './primitives';
import type { EnvironmentLabel } from './primitives';

// Upper-case alphanumeric only, 1..36: guards path injection when the id is put in a URL (7.1).
export const ProviderOrderIdSchema = z.string().regex(/^[A-Z0-9]{1,36}$/);
export type ProviderOrderId = z.infer<typeof ProviderOrderIdSchema>;
export const ProviderOrderStatusSchema = z.enum([
  'CREATED',
  'SAVED',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'PAYER_ACTION_REQUIRED',
]);
export type ProviderOrderStatus = z.infer<typeof ProviderOrderStatusSchema>;
// No REVERSED: PayPal does not report it as a capture status.
export const CaptureStatusSchema = z.enum([
  'COMPLETED',
  'DECLINED',
  'PARTIALLY_REFUNDED',
  'PENDING',
  'REFUNDED',
  'FAILED',
]);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export const RefundStatusSchema = z.enum(['CANCELLED', 'FAILED', 'PENDING', 'COMPLETED']);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

const debugId = z.string().nullable();

// The buyer's browser is sent to this address, so only the sandbox approval host is accepted (P15).
// The host is a different one from the API base URL, which lives in packages/transport/src/endpoints.ts.
const APPROVE_URL_PATTERN = /^https:\/\/www\.sandbox\.paypal\.com\/[!-~]*$/;
const ApproveUrlSchema = z.string().regex(APPROVE_URL_PATTERN);

// Return and cancel addresses: https, or http://localhost for offline runs; no userinfo, no fragment.
// Whether they sit under the configured public_origin is checked with isUrlUnderOrigin.
const PayerReturnUrlSchema = z.url().refine((value) => {
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return false;
    return (
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}, 'must be https (or http://localhost) with no userinfo or fragment');

/** True when `url` has exactly the origin of `origin` (scheme, host and port) and no userinfo. */
export function isUrlUnderOrigin(url: string, origin: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(origin);
    return target.origin === base.origin && target.username === '' && target.password === '';
  } catch {
    return false;
  }
}
export const PayPalFailSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rejected'),
      http: z.union([z.literal(400), z.literal(403), z.literal(422)]),
      name: z.string(),
      issue: z.string().nullable(),
      debug_id: debugId,
    })
    .strict(),
  z.object({ kind: z.literal('not_found'), debug_id: debugId }).strict(),
  z.object({ kind: z.literal('in_progress'), debug_id: debugId }).strict(),
  z
    .object({
      kind: z.literal('payer_action'),
      redirect_url: ApproveUrlSchema.nullable(),
      debug_id: debugId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      retry_after_ms: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('timeout') }).strict(),
  z.object({ kind: z.literal('blocked'), by: BlockReasonSchema }).strict(),
]);
export type PayPalFail = z.infer<typeof PayPalFailSchema>;

export const CreateOrderUnitSchema = z
  .object({ reference_id: IdSchema, payee_merchant_id: z.string().nullable(), amount: MoneySchema })
  .strict();
export type CreateOrderUnit = z.infer<typeof CreateOrderUnitSchema>;

export const CreateOrderReqSchema = z
  .object({
    request_id: z.string().min(1).max(108),
    order_ref: IdSchema,
    /** 1..10 units, one currency */
    units: z.array(CreateOrderUnitSchema).min(1).max(10),
    return_url: PayerReturnUrlSchema,
    cancel_url: PayerReturnUrlSchema,
    scenario: z.string().nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const first = r.units[0]?.amount.currency;
    if (r.units.some((u) => u.amount.currency !== first)) {
      ctx.addIssue({ code: 'custom', message: 'units must share one currency', path: ['units'] });
    }
    const refs = new Set<string>();
    r.units.forEach((u, i) => {
      if (refs.has(u.reference_id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate reference_id',
          path: ['units', i, 'reference_id'],
        });
      }
      refs.add(u.reference_id);
    });
  });
export type CreateOrderReq = z.infer<typeof CreateOrderReqSchema>;

export const CreateOrderResSchema = z.union([
  z
    .object({
      kind: z.literal('created'),
      provider_order_id: ProviderOrderIdSchema,
      status: ProviderOrderStatusSchema,
      approve_url: ApproveUrlSchema,
      debug_id: debugId,
    })
    .strict(),
  PayPalFailSchema,
]);
export type CreateOrderRes = z.infer<typeof CreateOrderResSchema>;

export const CapturedPartSchema = z
  .object({
    capture_id: z.string().min(1),
    status: CaptureStatusSchema,
    status_reason: z.string().nullable(),
    /** The captured amount as PayPal reports it. Payments compares it with the unit amount. */
    amount: MoneySchema,
    paypal_fee_minor: MinorUnitsSchema.nullable(),
    refunded_minor: MinorUnitsSchema,
  })
  .strict();
export type CapturedPart = z.infer<typeof CapturedPartSchema>;

export const OrderReadUnitSchema = z
  .object({
    reference_id: IdSchema,
    payee_merchant_id: z.string().nullable(),
    amount: MoneySchema,
    capture: CapturedPartSchema.nullable(),
  })
  .strict();
export type OrderReadUnit = z.infer<typeof OrderReadUnitSchema>;

export const OrderReadSchema = z.union([
  z
    .object({
      kind: z.literal('order'),
      provider_order_id: ProviderOrderIdSchema,
      status: ProviderOrderStatusSchema,
      custom_id: z.string().nullable(),
      read_at: IsoUtcSchema,
      debug_id: debugId,
      units: z.array(OrderReadUnitSchema),
    })
    .strict(),
  PayPalFailSchema,
]);
export type OrderRead = z.infer<typeof OrderReadSchema>;

export const ClaimUnitSchema = z
  .object({
    reference_id: IdSchema,
    capture_id: z.string().nullable(),
    status: CaptureStatusSchema.nullable(),
  })
  .strict();
export type ClaimUnit = z.infer<typeof ClaimUnitSchema>;

export const CaptureResSchema = z.union([
  z
    .object({
      kind: z.literal('claim'),
      http: z.union([z.literal(200), z.literal(201), z.literal(202), z.literal(207)]),
      provider_order_id: ProviderOrderIdSchema,
      units: z.array(ClaimUnitSchema),
      debug_id: debugId,
    })
    .strict(),
  PayPalFailSchema,
]);
export type CaptureRes = z.infer<typeof CaptureResSchema>;

export const CaptureReadSchema = z.union([
  z
    .object({
      kind: z.literal('capture'),
      capture: CapturedPartSchema,
      amount: MoneySchema,
      read_at: IsoUtcSchema,
      debug_id: debugId,
    })
    .strict(),
  PayPalFailSchema,
]);
export type CaptureRead = z.infer<typeof CaptureReadSchema>;

export const RefundReqSchema = z
  .object({
    capture_id: z.string().min(1),
    request_id: z.string().min(1),
    /** null = full remaining */
    amount: MoneySchema.nullable(),
    note: z.string(),
  })
  .strict();
export type RefundReq = z.infer<typeof RefundReqSchema>;

export const RefundResSchema = z.union([
  z
    .object({
      kind: z.literal('refund'),
      refund_id: z.string().min(1),
      status: RefundStatusSchema,
      amount: MoneySchema,
      capture_id: z.string().nullable(),
      debug_id: debugId,
    })
    .strict(),
  PayPalFailSchema,
]);
export type RefundRes = z.infer<typeof RefundResSchema>;

export const ProviderEventTypeSchema = z.enum([
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
export type ProviderEventType = z.infer<typeof ProviderEventTypeSchema>;

export const ProviderEventSchema = z
  .object({
    event_id: z.string().min(1),
    transmission_id: z.string().min(1),
    type: ProviderEventTypeSchema,
    provider_order_id: ProviderOrderIdSchema.nullable(),
    capture_id: z.string().nullable(),
    refund_id: z.string().nullable(),
    occurred_at: IsoUtcSchema,
  })
  .strict();
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export const WebhookVerdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verified'), event: ProviderEventSchema }).strict(),
  z.object({ kind: z.literal('bad_signature'), why: z.string() }).strict(),
  z.object({ kind: z.literal('malformed') }).strict(),
  z.object({ kind: z.literal('unverifiable') }).strict(),
]);
export type WebhookVerdict = z.infer<typeof WebhookVerdictSchema>;

export interface PayPalPort {
  readonly environment: EnvironmentLabel;
  createOrder(r: CreateOrderReq): Promise<CreateOrderRes>;
  getOrder(id: ProviderOrderId, scenario?: string | null): Promise<OrderRead>;
  captureOrder(r: {
    provider_order_id: ProviderOrderId;
    request_id: string;
    scenario?: string | null;
  }): Promise<CaptureRes>;
  getCapture(capture_id: string, scenario?: string | null): Promise<CaptureRead>;
  /** MVP-C; MVP-A implements against fixtures only */
  refundCapture(r: RefundReq): Promise<RefundRes>;
  /** MVP-C */
  getRefund(refund_id: string): Promise<RefundRes>;
  /** MVP-C */
  verifyWebhook(w: { headers: Record<string, string>; raw_body: string }): Promise<WebhookVerdict>;
}
