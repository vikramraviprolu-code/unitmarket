// Create-order request body (architecture 3 step 7, lane 04 request rules).
import { CreateOrderReqSchema } from '@umsbx/contracts';
import type { CreateOrderReq, PayPalFail } from '@umsbx/contracts';
import { checkRequestId } from './headers';
import { minorUnitsFor, toDecimalString } from './money';

export interface CreateBodyUnit {
  reference_id: string;
  custom_id: string;
  invoice_id: string;
  amount: { currency_code: string; value: string };
  payee?: { merchant_id: string };
}
export interface CreateBody {
  intent: 'CAPTURE';
  purchase_units: CreateBodyUnit[];
  payment_source: {
    paypal: {
      experience_context: {
        return_url: string;
        cancel_url: string;
        user_action: 'PAY_NOW';
        shipping_preference: 'NO_SHIPPING';
      };
    };
  };
}

// PayPal field limits (architecture 0): reference_id 256, custom_id 255, invoice_id 127.
const MAX_REFERENCE = 256;
const MAX_CUSTOM = 255;
const MAX_INVOICE = 127;

const invoiceIdFor = (r: CreateOrderReq, index: number): string =>
  r.invoice_id !== undefined
    ? r.invoice_id
    : r.units.length === 1
      ? r.order_ref
      : `${r.order_ref}-${index}`;

/** Local checks before anything is sent. Null means the request may go. */
export function checkCreate(r: CreateOrderReq): PayPalFail | null {
  const bad = checkRequestId(r.request_id);
  if (bad !== null) return bad;
  const parsed = CreateOrderReqSchema.safeParse(r);
  if (!parsed.success) {
    return {
      kind: 'rejected',
      http: 400,
      name: 'REQUEST_INVALID',
      issue: parsed.error.issues[0]?.path.join('.') || 'request',
      debug_id: null,
    };
  }
  const tooLong =
    r.order_ref.length > MAX_CUSTOM ||
    r.units.some(
      (u, i) => u.reference_id.length > MAX_REFERENCE || invoiceIdFor(r, i).length > MAX_INVOICE,
    );
  if (tooLong) {
    return {
      kind: 'rejected',
      http: 400,
      name: 'REQUEST_INVALID',
      issue: 'FIELD_TOO_LONG',
      debug_id: null,
    };
  }
  return null;
}

/**
 * D-028 (option c). `ownMerchantId` is our own sandbox merchant id (a non-secret config value). A unit
 * whose payee equals it exactly is sent without `payee`: PayPal then answers with the account the
 * credentials belong to, and the read-back expects that same id (the stored payee). Strict equality,
 * no folding, trimming or prefix match. Unset, null or empty: every payee stays in the body.
 */
export const leavesPayeeOut = (payee: string | null, ownMerchantId: string | null | undefined) =>
  payee !== null &&
  typeof ownMerchantId === 'string' &&
  ownMerchantId !== '' &&
  payee === ownMerchantId;

export function buildCreateBody(r: CreateOrderReq, ownMerchantId?: string | null): CreateBody {
  return {
    intent: 'CAPTURE',
    purchase_units: r.units.map((u, i) => ({
      reference_id: u.reference_id,
      custom_id: r.order_ref,
      invoice_id: invoiceIdFor(r, i),
      amount: {
        currency_code: u.amount.currency,
        value: toDecimalString(u.amount, minorUnitsFor(u.amount.currency)),
      },
      ...(u.payee_merchant_id === null || leavesPayeeOut(u.payee_merchant_id, ownMerchantId)
        ? {}
        : { payee: { merchant_id: u.payee_merchant_id } }),
    })),
    payment_source: {
      paypal: {
        experience_context: {
          return_url: r.return_url,
          cancel_url: r.cancel_url,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    },
  };
}
