// INT-BUY / BUY.1 and BUY.2: the logic of the Agents page and of the cap line. Pure: no server module, no clock
// (the caller passes `now`), no identity. The components paint what this returns.
import { formatMinor } from './format';
import { capDay, purchasesWord } from './buyer-copy';

/** The mandate fields the buyer sees (the contract's MandateView, which names no buyer). */
export interface CapInput {
  id: string;
  agent_key_id: string;
  currency: string;
  max_total_minor: number | null;
  max_count: number | null;
  max_per_purchase_minor: number | null;
  expires_at: string;
  revoked_at: string | null;
  spent_minor: number;
  used_count: number;
  remaining_total_minor: number | null;
  remaining_count: number | null;
  created_at: string;
}

export type CapState = 'open' | 'used_up' | 'expired' | 'revoked';
export const CAP_STATE_WORDS: Readonly<Record<CapState, string>> = {
  open: 'Open',
  used_up: 'Used up',
  expired: 'Expired',
  revoked: 'Revoked',
};

export interface MoneyMeter {
  spent_text: string;
  cap_text: string;
  left_text: string;
  percent: number;
}
export interface CountMeter {
  used: number;
  cap: number;
  left: number;
  percent: number;
}
export interface CapCardView {
  id: string;
  agent_key_id: string;
  state: CapState;
  state_word: string;
  until_text: string;
  per_purchase_text: string | null;
  money: MoneyMeter | null;
  count: CountMeter | null;
  can_revoke: boolean;
}

const pct = (part: number, whole: number): number =>
  whole <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((part / whole) * 100)));

export function capState(m: CapInput, now: Date): CapState {
  if (m.revoked_at !== null) return 'revoked';
  if (now.getTime() >= new Date(m.expires_at).getTime()) return 'expired';
  const moneyGone = m.remaining_total_minor !== null && m.remaining_total_minor <= 0;
  const countGone = m.remaining_count !== null && m.remaining_count <= 0;
  return moneyGone || countGone ? 'used_up' : 'open';
}

export function capCard(m: CapInput, now: Date): CapCardView {
  const state = capState(m, now);
  return {
    id: m.id,
    agent_key_id: m.agent_key_id,
    state,
    state_word: CAP_STATE_WORDS[state],
    until_text: `Until ${capDay(m.expires_at)}`,
    per_purchase_text:
      m.max_per_purchase_minor === null
        ? null
        : `Up to ${formatMinor(m.max_per_purchase_minor, m.currency)} for each purchase`,
    money:
      m.max_total_minor === null
        ? null
        : {
            spent_text: formatMinor(m.spent_minor, m.currency),
            cap_text: formatMinor(m.max_total_minor, m.currency),
            left_text: formatMinor(m.remaining_total_minor ?? 0, m.currency),
            percent: pct(m.spent_minor, m.max_total_minor),
          },
    count:
      m.max_count === null
        ? null
        : {
            used: m.used_count,
            cap: m.max_count,
            left: m.remaining_count ?? 0,
            percent: pct(m.used_count, m.max_count),
          },
    can_revoke: state === 'open' || state === 'used_up',
  };
}

/** BUY.2: what the agent hand-off page says about the cap, or null when the order used no cap. */
export function capLine(m: CapInput | null, now: Date): string | null {
  if (m === null) return null;
  const state = capState(m, now);
  if (state === 'revoked' || state === 'expired')
    return `Agent cap: ${CAP_STATE_WORDS[state].toLowerCase()}.`;
  const parts: string[] = [];
  if (m.max_total_minor !== null) parts.push(formatMinor(m.remaining_total_minor ?? 0, m.currency));
  if (m.max_count !== null) parts.push(purchasesWord(m.remaining_count ?? 0));
  return `Agent cap left: ${parts.join(' and ')}.`;
}

export interface AgentKeyInput {
  id: string;
  label: string;
  revoked: boolean;
}
export interface AgentRow {
  key_id: string;
  key_label: string;
  cap: CapCardView | null;
}
export interface AgentsModel {
  rows: AgentRow[];
  /** Keys that may be given a new cap: not revoked, and with no open cap. */
  newCapKeys: { id: string; label: string }[];
  empty: string | null;
}

export const AGENTS_EMPTY =
  'You have no agent key yet. Make one under API keys, then give it a cap here.';

/** One row for each live agent key, with its newest cap. `caps` is newest first (listCaps). */
export function agentsModel(i: {
  keys: readonly AgentKeyInput[];
  caps: readonly CapInput[];
  now: Date;
}): AgentsModel {
  const live = i.keys.filter((k) => !k.revoked);
  const rows = live.map((k): AgentRow => {
    const newest = i.caps.find((c) => c.agent_key_id === k.id) ?? null;
    return {
      key_id: k.id,
      key_label: k.label,
      cap: newest === null ? null : capCard(newest, i.now),
    };
  });
  const newCapKeys = rows
    .filter((r) => r.cap === null || (r.cap.state !== 'open' && r.cap.state !== 'used_up'))
    .map((r) => ({ id: r.key_id, label: r.key_label }));
  return { rows, newCapKeys, empty: rows.length === 0 ? AGENTS_EMPTY : null };
}

// ---- the New cap form: text in, request body out ----

export const CAP_PROBLEMS = {
  noKey: 'Choose an agent key.',
  nothingSet: 'Give a money cap, a number of purchases, or both.',
  badMoney: 'Write the money cap as a number, for example 5 or 5.00.',
  badCount: 'Write the number of purchases as a whole number, for example 50.',
  noDate: 'Choose the day the cap ends.',
} as const;

export interface CapFormInput {
  agent_key_id: string;
  currency: string;
  money_text: string;
  count_text: string;
  /** YYYY-MM-DD from a date input. The cap ends at the end of that day, UTC. */
  until_day: string;
}
export interface CapRequest {
  agent_key_id: string;
  currency: string;
  max_total_minor?: number;
  max_count?: number;
  expires_at: string;
  terms_accepted: true;
}

const MINOR_DIGITS = (currency: string): number => (currency === 'JPY' ? 0 : 2);

/** "5", "5.5" and "5.00" are money; "", "five" and "5.005" are not. Returns minor units or null. */
export function moneyToMinor(text: string, currency: string): number | null {
  const t = text.trim();
  const digits = MINOR_DIGITS(currency);
  const m = /^(\d{1,7})(?:\.(\d+))?$/.exec(t);
  if (m === null) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  return minor > 0 && minor < 2 ** 31 ? minor : null;
}

export function capRequest(
  i: CapFormInput,
): { ok: true; body: CapRequest } | { ok: false; problem: string } {
  if (i.agent_key_id === '') return { ok: false, problem: CAP_PROBLEMS.noKey };
  const hasMoney = i.money_text.trim() !== '';
  const hasCount = i.count_text.trim() !== '';
  if (!hasMoney && !hasCount) return { ok: false, problem: CAP_PROBLEMS.nothingSet };
  const money = hasMoney ? moneyToMinor(i.money_text, i.currency) : null;
  if (hasMoney && money === null) return { ok: false, problem: CAP_PROBLEMS.badMoney };
  const count =
    hasCount && /^\d{1,9}$/.test(i.count_text.trim()) ? Number(i.count_text.trim()) : null;
  if (hasCount && (count === null || count < 1 || count >= 2 ** 31))
    return { ok: false, problem: CAP_PROBLEMS.badCount };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.until_day)) return { ok: false, problem: CAP_PROBLEMS.noDate };
  return {
    ok: true,
    body: {
      agent_key_id: i.agent_key_id,
      currency: i.currency,
      ...(money === null ? {} : { max_total_minor: money }),
      ...(count === null ? {} : { max_count: count }),
      expires_at: `${i.until_day}T23:59:59.000Z`,
      terms_accepted: true,
    },
  };
}

/** One Idempotency-Key per page load and request body: the same body replays, another body is a new request. */
export function idemFor(nonce: string, body: unknown): string {
  const text = JSON.stringify(body);
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${nonce}-${h.toString(16).padStart(8, '0')}`.slice(0, 128);
}

/** What the server says to a refused create or revoke, in words for the page. */
export const CAP_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  mandate_active: 'This agent key already has an open cap. End it first.',
  invalid_expiry: 'The cap must end in the future and within 90 days.',
  not_found: 'We could not find that agent key or cap.',
  invalid_input: 'Check the amounts and the day and try again.',
  rate_limited: 'Too many changes in a short time. Try again later.',
};
