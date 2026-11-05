// INT-BUY / BUY.5: the logic of the buyer Home. Pure. Four sections in a fixed order: what needs the buyer's OK,
// what to continue reading, the agent spend meter (the mandate numbers) and recent spending. Every section has
// words when it is empty. A signed-out visitor, a seller or an operator gets the public explainer instead (N4).
import type { TxnLine } from '@umsbx/contracts';
import { formatMinor } from './format';
import { capCard, capState } from './buyer-agents-view';
import type { CapCardView, CapInput } from './buyer-agents-view';
import { spendingModel } from './buyer-spending-view';

export const HOME_ORDER = ['needs_ok', 'continue_reading', 'agent_spend', 'recent'] as const;
export type HomeSectionId = (typeof HOME_ORDER)[number];

export const HOME_HEADINGS: Readonly<Record<HomeSectionId, string>> = {
  needs_ok: 'Needs your OK',
  continue_reading: 'Continue reading',
  agent_spend: 'Your agents and their cap',
  recent: 'Recent spending',
};
export const HOME_EMPTY: Readonly<Record<HomeSectionId, string>> = {
  needs_ok: 'Nothing is waiting for you. A purchase that needs your approval shows here.',
  continue_reading: 'Nothing to continue yet. Items you have bought open from your library.',
  agent_spend:
    'No agent has a cap. Give an agent key a cap under Agents when you want it to buy for you.',
  recent: 'You have not bought anything yet. Find an article to get started.',
};

/** Who gets the Home: only a signed-in buyer. Everyone else gets today's public text. */
export function homeAudience(
  kind: 'buyer' | 'publisher' | 'operator' | 'system' | null,
): 'home' | 'public' {
  return kind === 'buyer' ? 'home' : 'public';
}

export interface PendingApprovalInput {
  approval_id: string;
  titles: string[];
  total_minor: number;
  currency: string;
  expires_at: string;
}
export interface ReadingInput {
  entitlement_id: string;
  title: string;
  publisher: string;
  days_left: number | null;
}

export interface HomeItem {
  key: string;
  href: string;
  text: string;
  note: string | null;
  meter?: CapCardView;
}
export interface HomeSection {
  id: HomeSectionId;
  heading: string;
  empty: string | null;
  items: HomeItem[];
  /** A link under the section to the full page, or null. */
  more: { href: string; label: string } | null;
}
export interface HomeModel {
  sections: HomeSection[];
}

export function endsIn(expires_at: string, now: Date): string {
  const ms = new Date(expires_at).getTime() - now.getTime();
  if (ms <= 0) return 'Ended.';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `Ends in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  const hours = Math.round(minutes / 60);
  return `Ends in ${String(hours)} ${hours === 1 ? 'hour' : 'hours'}.`;
}

export function homeModel(i: {
  pending: readonly PendingApprovalInput[];
  reading: readonly ReadingInput[];
  caps: readonly CapInput[];
  recent: readonly TxnLine[];
  now: Date;
}): HomeModel {
  const needs: HomeItem[] = i.pending.map((p) => ({
    key: p.approval_id,
    href: `/approve/${encodeURIComponent(p.approval_id)}`,
    text: `${p.titles.join(', ')}, ${formatMinor(p.total_minor, p.currency)}`,
    note: endsIn(p.expires_at, i.now),
  }));
  const reading: HomeItem[] = i.reading.map((r) => ({
    key: r.entitlement_id,
    href: `/library/${encodeURIComponent(r.entitlement_id)}`,
    text: `${r.title}, ${r.publisher}`,
    note:
      r.days_left === null
        ? null
        : `${String(r.days_left)} ${r.days_left === 1 ? 'day' : 'days'} left.`,
  }));
  const spend: HomeItem[] = i.caps
    .filter((c) => capState(c, i.now) === 'open')
    .map((c) => ({
      key: c.id,
      href: '/buyer/agents',
      text: `Agent key ${c.agent_key_id.slice(-4)}`,
      note: null,
      meter: capCard(c, i.now),
    }));
  const recent: HomeItem[] = spendingModel(i.recent, i.now).rows.map((r) => ({
    key: r.key,
    href: r.href,
    text: `${r.items}, ${r.money_text}`,
    note: `${r.status_word}. ${r.when}.`,
  }));
  const section = (
    id: HomeSectionId,
    items: HomeItem[],
    more: HomeSection['more'] = null,
  ): HomeSection => ({
    id,
    heading: HOME_HEADINGS[id],
    empty: items.length === 0 ? HOME_EMPTY[id] : null,
    items,
    more: items.length === 0 ? null : more,
  });
  return {
    sections: [
      section('needs_ok', needs, { href: '/buyer/approvals', label: 'All approvals' }),
      section('continue_reading', reading, { href: '/library', label: 'Open my library' }),
      section('agent_spend', spend, { href: '/buyer/agents', label: 'Manage agents' }),
      section('recent', recent, { href: '/buyer/spending', label: 'All spending' }),
    ],
  };
}
