// What the static cancel page shows for the `ref` that PayPal's cancel URL carries (DP-5b, H1). Pure:
// the ref is only shape-checked and put in a link. Nothing is looked up and nothing is done with it;
// the page it points to (/checkout/return) takes the ref again behind buyer sign-in and the
// navigation guard, and says where the order stands.
import { IdSchema } from '@umsbx/contracts';
import { CANCEL_BODY, CANCEL_BODY_NO_REF, CANCEL_WINDOW_LINE } from './composite-copy';

// IdSchema is the id check the engine applies to an order ref (onBuyerReturn). It is loose (any
// non-space text up to 200 characters), so the shape of the refs we generate is required as well:
// `ord_` plus base32 (the only place that makes an order ref is place.ts, `ids.next('ord')`, and both
// id sources format it as prefix, underscore, base32). A ref that could change a URL (a slash, a
// colon, a percent, a query or fragment mark) never gets a link.
const REF_SHAPE = /^ord_[A-Za-z0-9_]{1,60}$/;

export function validOrderRef(v: string | string[] | undefined): string | null {
  if (typeof v !== 'string') return null;
  return IdSchema.safeParse(v).success && REF_SHAPE.test(v) ? v : null;
}

export interface CancelView {
  body: string;
  window_line: string | null;
  back_href: string | null;
}

export function cancelView(ref: string | string[] | undefined): CancelView {
  const ok = validOrderRef(ref);
  if (ok === null) return { body: CANCEL_BODY_NO_REF, window_line: null, back_href: null };
  return {
    body: CANCEL_BODY,
    window_line: CANCEL_WINDOW_LINE,
    back_href: `/checkout/return?ref=${encodeURIComponent(ok)}`,
  };
}
