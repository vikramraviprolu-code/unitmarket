// The header items for each role (FIX-FLOW D11). Pure, so a unit test can pin it: the layout only renders
// what this returns. A publisher or an operator is never offered "Find articles" (it is a buyer screen
// and would send them to "Sign in first"). Every signed in actor gets a sign out control.
import { PUBLISHER_NAV_LABEL } from './publisher-copy';

export const SIGN_OUT_LABEL = 'Sign out';

export type NavActorKind = 'buyer' | 'publisher' | 'operator' | null;
export interface NavItem {
  label: string;
  href: string;
}

const FIND: NavItem = { label: 'Find articles', href: '/discover' };
const HELP: NavItem = { label: 'Help', href: '/help/payment' };

export function navItems(kind: NavActorKind): { items: NavItem[]; sign_out: boolean } {
  switch (kind) {
    case 'buyer':
      return { items: [FIND, { label: 'My library', href: '/library' }, HELP], sign_out: true };
    case 'publisher':
      return { items: [{ label: PUBLISHER_NAV_LABEL, href: '/publisher' }, HELP], sign_out: true };
    case 'operator':
      return { items: [{ label: 'Operations', href: '/ops' }, HELP], sign_out: true };
    default:
      return { items: [FIND, HELP, { label: 'Sign in', href: '/signin' }], sign_out: false };
  }
}
