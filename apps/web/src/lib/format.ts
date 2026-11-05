// Display helpers. Pure; no real time, no randomness.
import { RULES_REGISTRY } from '@umsbx/contracts';

export function formatMinor(minor: number, currency: string): string {
  const digits = currency === 'JPY' ? 0 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(digits === 0 ? minor : minor / 100);
}

export const OPTION_LABEL = {
  keep_retrieve: 'Download and keep',
  online_read: 'Read online',
} as const;

// BR-3: how long a buyer has depends on the terms resolved for the sale (the rules registry, then any seller or
// buyer setting), so a page that has no approval or entitlement yet shows the platform default and says so
// on the approval screen, which reads the frozen days. The default is the longer of the access and refund defaults.
export const DEFAULT_ACCESS_DAYS = Math.max(
  RULES_REGISTRY['access.window'].default,
  RULES_REGISTRY['refund.request_window'].default,
);

const daysText = (days: number): string => `${days} ${days === 1 ? 'day' : 'days'}`;

export function optionHelp(option: keyof typeof OPTION_LABEL, days: number = DEFAULT_ACCESS_DAYS) {
  return option === 'keep_retrieve'
    ? `You have ${daysText(days)} to download your copy. It is yours to keep.`
    : `You can read it online for ${daysText(days)}.`;
}

/** The offer page's help lines at the platform default (no approval yet). */
export const OPTION_HELP = {
  keep_retrieve: optionHelp('keep_retrieve'),
  online_read: optionHelp('online_read'),
} as const;

export function optionLabel(option: string): string {
  return option === 'keep_retrieve' || option === 'online_read' ? OPTION_LABEL[option] : option;
}

export function formatDateTime(isoUtc: string): string {
  return `${isoUtc.slice(0, 16).replace('T', ' ')} UTC`;
}
