// The reporting block of the operations screen (MC2-L7, D-084 item 5, ledger A1 and A6). Pure: no server
// module, no clock, no database. It takes the booked totals the read model made and an engine-shaped
// `convert`, and returns the words and figures to show. The booked figures come first, one row per currency.
// The reporting view then converts each currency subtotal on its own (the engine rounds half away from zero),
// adds the converted parts, and labels every figure "about" with the rate date. A rate that came from the
// build's seed is called a sample rate, and no source is ever named. With no usable rate there is no
// reporting view, only the booked figures and one note. Wording rules: D-051, no italics, no dashes.
import { formatMinor } from './format';

export type ReportingCurrency = 'USD' | 'EUR' | 'GBP';
export const REPORTING_CURRENCIES: readonly ReportingCurrency[] = ['USD', 'EUR', 'GBP'];

export interface BookedTotal {
  environment: 'dryrun' | 'sandbox';
  currency: string;
  sales_minor: number;
  refunds_minor: number;
  exposure_minor: number;
}

/** What the view needs from engine.fx: its `convert` and the rates it converts with. */
export interface ReportingFx<R> {
  rates: R;
  /** The moment the age of the rate is judged against; the engine uses its clock when this is left out. */
  at?: Date;
  convert(i: {
    minor: number;
    from: ReportingCurrency;
    to: ReportingCurrency;
    rates: R;
    at?: Date;
  }): { minor: number; rate_date: string | null; source: 'ecb' | 'seed' | null } | null;
}

export interface FigureRow {
  label: string;
  sales: string;
  refunds: string;
  exposure: string;
}

export interface ReportingGroup {
  environment: 'dryrun' | 'sandbox';
  booked: FigureRow[];
  reporting: { rows: FigureRow[]; rate_note: string; how_note: string } | null;
  missing_note: string | null;
}

export interface OpsReportingView {
  groups: ReportingGroup[];
  empty: string | null;
  statements_note: string;
}

export const OPS_REPORTING_HEADING = 'Totals by currency';
export const OPS_REPORTING_LEDE =
  'Sales, refunds and exposure as booked, one row for each currency. Exposure is money paid and not refunded, plus money held.';
export const OPS_REPORTING_COLUMNS = {
  sales: 'Sales',
  refunds: 'Refunds',
  exposure: 'Exposure',
} as const;
export const OPS_REPORTING_BOOKED_CAPTION = 'As booked';
export const OPS_REPORTING_VIEW_CAPTION = 'Reporting view';
export const OPS_REPORTING_EMPTY = 'No sales, refunds or held payments yet.';
export const OPS_REPORTING_HOW_NOTE =
  'Each currency total is converted on its own and rounded to the nearest cent, halves away from zero. The converted parts are then added.';
export const OPS_REPORTING_MISSING_NOTE =
  'No exchange rate from the last 7 days is stored, so only the figures in each currency are shown.';
export const OPS_REPORTING_STATEMENTS_NOTE =
  'Seller statements and exports stay in the original currency. Nothing here is written to the ledger.';

const rateNote = (date: string, source: 'ecb' | 'seed' | null): string =>
  source === 'seed'
    ? `Reporting view: about, at the sample rate of ${date}.`
    : `Reporting view: about, at the rate of ${date}.`;

const isReporting = (c: string): c is ReportingCurrency =>
  c === 'USD' || c === 'EUR' || c === 'GBP';

const rank = (c: string): number => {
  const i = REPORTING_CURRENCIES.indexOf(c as ReportingCurrency);
  return i === -1 ? REPORTING_CURRENCIES.length : i;
};

const figures = (label: string, c: string, r: BookedTotal, about: boolean): FigureRow => ({
  label,
  sales: `${about ? 'about ' : ''}${formatMinor(r.sales_minor, c)}`,
  refunds: `${about ? 'about ' : ''}${formatMinor(r.refunds_minor, c)}`,
  exposure: `${about ? 'about ' : ''}${formatMinor(r.exposure_minor, c)}`,
});

function groupOf<R>(
  environment: 'dryrun' | 'sandbox',
  rows: BookedTotal[],
  fx: ReportingFx<R>,
): ReportingGroup {
  const sorted = [...rows].sort(
    (a, b) => rank(a.currency) - rank(b.currency) || (a.currency < b.currency ? -1 : 1),
  );
  const booked = sorted.map((r) => figures(r.currency, r.currency, r, false));
  let usable = sorted.every((r) => isReporting(r.currency));
  let rateDate: string | null = null;
  let source: 'ecb' | 'seed' | null = null;
  const out: FigureRow[] = [];
  for (const to of usable ? REPORTING_CURRENCIES : []) {
    const sum = { sales_minor: 0, refunds_minor: 0, exposure_minor: 0 };
    for (const r of sorted) {
      for (const key of ['sales_minor', 'refunds_minor', 'exposure_minor'] as const) {
        const res = fx.convert({
          minor: r[key],
          from: r.currency as ReportingCurrency,
          to,
          rates: fx.rates,
          ...(fx.at === undefined ? {} : { at: fx.at }),
        });
        if (res === null) {
          usable = false;
          break;
        }
        sum[key] += res.minor;
        if (res.rate_date !== null) {
          rateDate = res.rate_date;
          source = res.source;
        }
      }
      if (!usable) break;
    }
    if (!usable) break;
    out.push(figures(`In ${to}`, to, { environment, currency: to, ...sum }, true));
  }
  if (!usable || rateDate === null) {
    return { environment, booked, reporting: null, missing_note: OPS_REPORTING_MISSING_NOTE };
  }
  return {
    environment,
    booked,
    reporting: {
      rows: out,
      rate_note: rateNote(rateDate, source),
      how_note: OPS_REPORTING_HOW_NOTE,
    },
    missing_note: null,
  };
}

export function opsReportingView<R>(
  totals: readonly BookedTotal[],
  fx: ReportingFx<R>,
): OpsReportingView {
  const byEnv = new Map<'dryrun' | 'sandbox', BookedTotal[]>();
  for (const t of totals) byEnv.set(t.environment, [...(byEnv.get(t.environment) ?? []), t]);
  const groups = [...byEnv.keys()].sort().map((env) => groupOf(env, byEnv.get(env)!, fx));
  return {
    groups,
    empty: groups.length === 0 ? OPS_REPORTING_EMPTY : null,
    statements_note: OPS_REPORTING_STATEMENTS_NOTE,
  };
}
