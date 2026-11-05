// GATEFIX2 item 2: a help page opens a case only from an item. The case route needs an item (or an order) to
// attach to; with none, the button could only answer "We could not find that item". Pure: no server module.

export const HELP_NO_ITEM_NOTE =
  'To ask us to look at a particular item, open it in your library and choose Problem with this item.';
export const HELP_NO_ITEM_LINK = 'Open My library';

export interface HelpView {
  /** Show "Ask us to look at this": only when an item is named. */
  canOpenCase: boolean;
  /** Plain guidance shown instead of the button, or null when the button is shown. */
  note: string | null;
  link: { href: string; text: string } | null;
  /** INT-BUY / BUY.3: the order the buyer came from, when the link named one. Absent otherwise. */
  order_ref?: string;
}

const REF_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;

export function helpView(_slug: string, item: string | undefined, order?: string): HelpView {
  const named = order !== undefined && REF_SHAPE.test(order) ? { order_ref: order } : {};
  if (item !== undefined && item !== '')
    return { canOpenCase: true, note: null, link: null, ...named };
  return {
    canOpenCase: false,
    note: HELP_NO_ITEM_NOTE,
    link: { href: '/library', text: HELP_NO_ITEM_LINK },
    ...named,
  };
}
