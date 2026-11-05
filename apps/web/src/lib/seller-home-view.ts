// INT-SEL / SEL.3, SEL.4: the seller Home as words and tiles. Pure: no server module, no clock (the windows
// are worked out from the `now` the caller passes, from the injected Clock), no randomness. Every figure is
// read from a stored row; nothing is added up here except the statement net the caller already computed, and
// the PayPal fee is never part of it. A seller with no sales gets words, never NaN or a blank.
import type { EnvironmentLabel } from '@umsbx/contracts';
import { formatMinor } from './format';
import { SEVERAL_ARTICLES_NOTE } from './seller-offer-view';
import type { OfferFigures } from './seller-offer-view';

const DAY = 86_400_000;

export interface Window {
  from: Date;
  to: Date;
}

/** "This week" is the 7 days ending at now; "last 30 days" is the 30 days ending at now (UTC, F4). */
export function sellerWindows(now: Date): { week: Window; month: Window } {
  return {
    week: { from: new Date(now.getTime() - 7 * DAY), to: now },
    month: { from: new Date(now.getTime() - 30 * DAY), to: now },
  };
}

export interface AgentShare {
  agent_units: number;
  total_units: number;
}

export interface AgentShareView {
  empty: boolean;
  value: string;
  note: string;
}

export const NO_SALES_7 = 'No sales in the last 7 days.';
export const NO_SALES_30 = 'No sales in the last 30 days.';

export function agentShareView(s: AgentShare): AgentShareView {
  if (s.total_units <= 0) return { empty: true, value: '', note: NO_SALES_30 };
  const pct = Math.round((100 * s.agent_units) / s.total_units);
  const verb = s.agent_units === 1 ? 'was' : 'were';
  return {
    empty: false,
    value: `${String(pct)}%`,
    note: `${String(s.agent_units)} of ${String(s.total_units)} sales in the last 30 days ${verb} bought by an agent.`,
  };
}

// ---------- this week ----------

export interface WeekFigures {
  currency: string;
  environment: EnvironmentLabel;
  units: number;
  gross_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  /** Gross minus refunds minus reversals: the statement net. */
  net_minor: number;
}

export interface TopOffer extends OfferFigures {
  title: string;
}

export interface SellerHomeRead {
  display_name: string;
  week: WeekFigures | null;
  agent: AgentShare;
  top: TopOffer[];
  needs_you: number;
}

export type WeekView =
  | {
      kind: 'figures';
      units_text: string;
      net_text: string;
      gross_text: string;
      refunds_text: string;
      note: string;
    }
  | { kind: 'empty'; text: string };

export interface TopOfferView {
  offer_id: string;
  title: string;
  units_text: string;
  net_text: string;
  href: string;
  /** Set only when a note belongs on this row alone. */
  title_note?: string;
}

export interface HomeView {
  week: WeekView;
  agent: AgentShareView;
  top: TopOfferView[];
  top_note: string;
  top_empty: string;
  needs_you: { count: number; text: string };
}

export const NEEDS_YOU_NONE = 'Nothing needs you right now.';
export const needsYouText = (n: number): string =>
  n <= 0 ? NEEDS_YOU_NONE : `${String(n)} ${n === 1 ? 'sale needs' : 'sales need'} you.`;

export const WEEK_NET_NOTE =
  'Net is gross minus refunds and reversals. The PayPal fee is not taken from it.';

export function homeView(h: SellerHomeRead): HomeView {
  const w = h.week;
  return {
    week:
      w === null || w.units <= 0
        ? { kind: 'empty', text: NO_SALES_7 }
        : {
            kind: 'figures',
            units_text: `${String(w.units)} ${w.units === 1 ? 'sale' : 'sales'} this week`,
            net_text: formatMinor(w.net_minor, w.currency),
            gross_text: formatMinor(w.gross_minor, w.currency),
            refunds_text: formatMinor(w.refunds_minor + w.reversals_minor, w.currency),
            note: WEEK_NET_NOTE,
          },
    agent: agentShareView(h.agent),
    top: h.top.map((t) => ({
      offer_id: t.offer_id,
      title: t.title,
      units_text: `${String(t.units)} ${t.units === 1 ? 'sale' : 'sales'}`,
      net_text: formatMinor(t.net_minor, t.currency),
      href: `/publisher/offers/${encodeURIComponent(t.offer_id)}`,
    })),
    top_note: SEVERAL_ARTICLES_NOTE,
    top_empty: NO_SALES_30,
    needs_you: { count: h.needs_you, text: needsYouText(h.needs_you) },
  };
}

// ---------- SEL.4 the setup path ----------

export type SetupStepId =
  'application' | 'terms' | 'payout_account' | 'payee_check' | 'first_offer';
export type SetupState = 'done' | 'waiting' | 'todo';

export interface SetupFacts {
  status: 'applied' | 'active' | 'suspended';
  terms_accepted: boolean;
  payee_last4: string | null;
  payee_verified: boolean;
  offers_total: number;
}

export interface SetupStep {
  id: SetupStepId;
  label: string;
  state: SetupState;
  href: string | null;
}

export const SETUP_HEADING = 'Set up your account';
export const SETUP_LABEL = 'Setup steps';
export const STATE_WORD: Record<SetupState, string> = {
  done: 'Done',
  waiting: 'Waiting',
  todo: 'To do',
};

/** Each step follows one stored fact. Nothing is guessed. */
export function setupSteps(f: SetupFacts): SetupStep[] {
  const payeeCheck: SetupState =
    f.payee_last4 === null ? 'todo' : f.payee_verified ? 'done' : 'waiting';
  return [
    {
      id: 'application',
      label: 'Your application is approved',
      state: f.status === 'applied' ? 'todo' : 'done',
      href: null,
    },
    {
      id: 'terms',
      label: 'You have accepted the publisher terms',
      state: f.terms_accepted ? 'done' : 'todo',
      href: '/legal/publisher-terms',
    },
    {
      id: 'payout_account',
      label: 'You have added a payout account',
      state: f.payee_last4 === null ? 'todo' : 'done',
      href: '/publisher/payout-account',
    },
    {
      id: 'payee_check',
      label: 'Your payout account is checked',
      state: payeeCheck,
      href: '/publisher/payout-account',
    },
    {
      id: 'first_offer',
      label: 'You have made your first offer',
      state: f.offers_total >= 1 ? 'done' : 'todo',
      href: '/publisher/offers/new',
    },
  ];
}

export const setupDone = (steps: readonly SetupStep[]): boolean =>
  steps.every((s) => s.state === 'done');

export const stateWord = (s: SetupState): string => STATE_WORD[s];
