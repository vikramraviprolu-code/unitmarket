// Display helpers. Pure; no real time, no randomness.
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

export const OPTION_HELP = {
  keep_retrieve: 'You have 5 days to download your copy. It is yours to keep.',
  online_read: 'You can read it online for 5 days.',
} as const;

export function optionLabel(option: string): string {
  return option === 'keep_retrieve' || option === 'online_read' ? OPTION_LABEL[option] : option;
}

export function formatDateTime(isoUtc: string): string {
  return `${isoUtc.slice(0, 16).replace('T', ' ')} UTC`;
}
