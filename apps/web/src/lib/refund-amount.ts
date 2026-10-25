// The operator types an amount as "1.50"; the route takes whole minor units. Pure (no clock, no
// randomness), shared by the refund form and its test.

/**
 * "1.50" gives 150 (USD, 2 digits). Empty text gives null: the rest. Text that is not an amount gives
 * undefined: more digits than the currency has, a sign, a comma, an exponent, zero. At most 7 whole
 * digits, so the number stays far below the route's own cap.
 */
export function parseAmount(text: string, digits: number): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const m = new RegExp(`^(\\d{1,7})(?:\\.(\\d{1,${Math.max(digits, 1)}}))?$`).exec(t);
  if (m === null || (digits === 0 && m[2] !== undefined)) return undefined;
  const minor = Number(m[1]) * 10 ** digits + Number((m[2] ?? '').padEnd(digits, '0') || '0');
  return minor > 0 ? minor : undefined;
}
