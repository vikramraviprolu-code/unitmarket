// The header items for each role (FIX-FLOW D11). Pure, so a unit test can pin it: the layout only renders
// what this returns. A publisher or an operator is never offered "Find articles" (it is a buyer screen
// and would send them to "Sign in first"). Every signed in actor gets a sign out control.
import { ACCOUNT_NAV_LABEL } from './account-copy';
import { PUBLISHER_NAV_LABEL } from './publisher-copy';
import { RULES_TITLE } from './ops-rules-copy';

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
      return {
        items: [
          FIND,
          { label: 'My library', href: '/library' },
          { label: ACCOUNT_NAV_LABEL, href: '/account' },
          HELP,
        ],
        sign_out: true,
      };
    case 'publisher':
      return { items: [{ label: PUBLISHER_NAV_LABEL, href: '/publisher' }, HELP], sign_out: true };
    case 'operator':
      return {
        items: [
          { label: 'Operations', href: '/ops' },
          { label: RULES_TITLE, href: '/ops/rules' },
          HELP,
        ],
        sign_out: true,
      };
    default:
      return { items: [FIND, HELP, { label: 'Sign in', href: '/signin' }], sign_out: false };
  }
}

/** GATE35 D7: /discover is a buyer screen. A publisher or operator is told so and offered their own home. */
export function discoverForNonBuyer(kind: 'publisher' | 'operator'): {
  line: string;
  href: string;
  label: string;
} {
  return kind === 'publisher'
    ? {
        line: 'Finding articles is for buyer accounts. You are signed in as a publisher.',
        href: '/publisher',
        label: 'Go to your publisher pages',
      }
    : {
        line: 'Finding articles is for buyer accounts. You are signed in as an operator.',
        href: '/ops',
        label: 'Go to operations',
      };
}
