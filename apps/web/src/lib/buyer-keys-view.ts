// INT-BUY / BUY.8 (F5): the logic of the API keys page. Pure. The secret of a new key lives only in the answer of
// the create call, held in client state for that one screen. It is never part of the list model, never written to
// a page and never stored: `issuedState` splits the answer into the secret to show once and the view to keep.
import type { ApiKeyIssueRequest, ApiKeyView } from '@umsbx/contracts';

export const KEYS_EMPTY =
  'You have no API keys yet. Make one to let a program or an agent act for you.';

export const KEY_PRESETS = {
  agent: {
    label: 'Agent key',
    help: 'For an AI agent that buys inside a cap you set on the Agents page.',
    key_kind: 'agent',
    scopes: ['catalogue:read', 'orders:read', 'library:read', 'agent:buy'],
  },
  read_only: {
    label: 'Read only key',
    help: 'For a program that only looks: it can read the catalogue, your orders and your library.',
    key_kind: 'api_client',
    scopes: ['catalogue:read', 'orders:read', 'library:read'],
  },
} as const;
export type KeyPreset = keyof typeof KEY_PRESETS;
export const KEY_PRESET_IDS = ['agent', 'read_only'] as const satisfies readonly KeyPreset[];

/** The body of POST /api/v1/api-keys for a preset. */
export function keyRequest(preset: KeyPreset): ApiKeyIssueRequest {
  const p = KEY_PRESETS[preset];
  return { key_kind: p.key_kind, scopes: [...p.scopes] };
}

const SCOPE_WORDS: Readonly<Record<string, string>> = {
  'catalogue:read': 'read the catalogue',
  'orders:read': 'read your orders',
  'library:read': 'read your library',
  'agent:buy': 'buy inside a cap',
  'mandates:write': 'set caps',
  'orders:write': 'place orders',
  'events:read': 'read events',
};
const scopeWord = (s: string): string => SCOPE_WORDS[s] ?? s;

export interface KeyRow {
  id: string;
  kind_word: string;
  scopes_text: string;
  state_word: 'Active' | 'Revoked';
  created_text: string;
  last_used_text: string;
  can_revoke: boolean;
}
export interface KeysModel {
  rows: KeyRow[];
  empty: string | null;
}

const day = (iso: string): string => iso.slice(0, 10);

/** The list of keys in words. Built from the API-W0 view, which has no secret and no hash. */
export function keysModel(views: readonly ApiKeyView[], now: Date): KeysModel {
  void now; // kept so every buyer model takes the clock the same way; dates are shown as stored
  const rows = views.map((k): KeyRow => ({
    id: k.id,
    kind_word: k.key_kind === 'agent' ? 'Agent key' : 'API client key',
    scopes_text: `Can ${k.scopes.map(scopeWord).join(', ')}.`,
    state_word: k.revoked_at === null ? 'Active' : 'Revoked',
    created_text: `Made ${day(k.created_at)}`,
    last_used_text: k.last_used_at === null ? 'Never used' : `Last used ${day(k.last_used_at)}`,
    can_revoke: k.revoked_at === null,
  }));
  return { rows, empty: rows.length === 0 ? KEYS_EMPTY : null };
}

/** What the create answer holds. `token` is the only secret. */
export type IssuedAnswer = ApiKeyView & { token: string };

/** Split a create answer: `shown` is for the one-time panel, `kept` (the view) may join the list. */
export function issuedState(answer: IssuedAnswer): { shown: { token: string }; kept: ApiKeyView } {
  const { token, ...kept } = answer;
  return { shown: { token }, kept };
}

export const KEY_ONCE_NOTE =
  'Copy this key now. We show it once and cannot show it again. If you lose it, revoke it and make a new one.';

export const KEY_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  not_found: 'We could not find that key.',
  forbidden: 'This account cannot do that.',
  rate_limited: 'Too many requests. Wait a little and try again.',
};
