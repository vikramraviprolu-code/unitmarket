// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/approval/snapshot.ts. Adapted; owned by SBX.
// contentHash: items sorted by article_id and publishers by publisher_id before hashing, so order
// never changes the hash.
import type { ApprovalSnapshot, Sha256Hex } from '@umsbx/contracts';
import { canonicalJson, sha256Hex } from './canonical';
import type { MinorUnits } from './canonical';

// Number of minor-unit digits per currency (ISO 4217 exponent) for the currencies a PayPal
// corridor can carry. A corridor row must agree with this table (checked in requestApproval),
// which lets contentHash stay a pure function of the snapshot. Adding a currency is one line.
const MINOR_UNITS: Readonly<Record<string, MinorUnits>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  NZD: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  SGD: 2,
  HKD: 2,
  MXN: 2,
  JPY: 0,
  HUF: 0,
  TWD: 0,
};

export function minorUnitsFor(currency: string): MinorUnits | null {
  return Object.hasOwn(MINOR_UNITS, currency) ? (MINOR_UNITS[currency] ?? null) : null;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function contentHash(s: ApprovalSnapshot): Sha256Hex {
  const digits = minorUnitsFor(s.currency);
  if (digits === null) throw new TypeError(`contentHash: no minor-unit digits for ${s.currency}`);
  return sha256Hex(
    canonicalJson(
      {
        ...s,
        items: [...s.items].sort((a, b) => byText(a.article_id, b.article_id)),
        publishers: [...s.publishers].sort((a, b) => byText(a.publisher_id, b.publisher_id)),
      },
      digits,
    ),
  );
}
