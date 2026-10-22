// PERF-2 offline twin (nfr.md PERF-2; MVP-B lane B-L7): times the quote and approval engine calls
// over 200 requests each against the dry-run app, in process, and fails when a p95 is above the
// budget. Offline: the app is built in dry-run mode on an in-memory database; no socket is opened
// and no credential is read. It measures the server's own work (the engine behind the quote and
// approval route handlers), not a browser or the network, so it is a twin of PERF-2, not a replacement
// for the hosted run.
//
//   node --conditions=react-server --import ./scripts/lib/ts-register.mjs scripts/perf-offline.mjs
//        [--n 200] [--budget-ms 300] [--out .data/perf-offline.json]
//   (pnpm perf:offline)
//
// Writes a small JSON result: { n, budget_ms, quote: {p50,p95,max}, approval: {...}, ok }. Exit 0 when
// both p95 are within the budget, 1 above it, 2 on bad arguments. `--budget-ms` exists for the
// self-test of the failing path; the default is the nfr.md figure and the CI run never lowers it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { systemClock } from '../packages/runtime/src/index.ts';

export const PERF2_BUDGET_MS = 300;
export const PERF2_N = 200;

/** Nearest-rank percentile of a list of numbers; q in (0, 1]. */
export function percentile(xs, q) {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function summarize(xs) {
  const r = (v) => Math.round(v * 100) / 100;
  return { p50: r(percentile(xs, 0.5)), p95: r(percentile(xs, 0.95)), max: r(Math.max(...xs)) };
}

/** Pure verdict, exported so a test can prove the script fails above the budget. */
export function verdict(quoteMs, approvalMs, budgetMs) {
  const quote = summarize(quoteMs);
  const approval = summarize(approvalMs);
  return {
    n: quoteMs.length,
    budget_ms: budgetMs,
    quote,
    approval,
    ok: quote.p95 <= budgetMs && approval.p95 <= budgetMs,
  };
}

// The injected-clock rule (S6) leaves the runtime package's real clock as the only timer: one
// millisecond of resolution, which is fine against a 300 ms budget (the samples are 3 to 15 ms).
const clock = systemClock();
const nowMs = () => clock.now().getTime();
const msSince = (t0) => nowMs() - t0;

export async function measure({ n = PERF2_N, budgetMs = PERF2_BUDGET_MS } = {}) {
  const { createApp, installApp } = await import('../apps/web/composition.server.ts');
  const { testEnv } = await import('../apps/web/src/support.ts');
  const app = createApp(await testEnv(), { switch_cache_ms: 0 });
  installApp(app);
  try {
    await app.ready();
    const offers = (await app.engine.listOffers()).filter(
      (o) => o.publisher_slug === 'harbour-ledger',
    );
    const actors = [];
    for (let i = 0; i < n; i += 1) {
      const id = `buy_perf${String(i).padStart(4, '0')}`;
      await app.db.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, 'Perf buyer', $2, 'US', now(), now())`,
        [id, `perf:${id}`],
      );
      actors.push({ kind: 'buyer', buyer_id: id });
    }
    const quoteMs = [];
    const approvalMs = [];
    for (let i = 0; i < n; i += 1) {
      const actor = actors[i];
      const offer = offers[i % offers.length];
      const page = await app.engine.offerPage({
        publisher: 'harbour-ledger',
        offer: offer.offer_code,
      });
      const t0 = nowMs();
      const q = await app.engine.quote({
        offer: { publisher_slug: 'harbour-ledger', offer_code: offer.offer_code },
        actor,
        source: 'direct',
        option: page.options[0].option,
      });
      quoteMs.push(msSince(t0));
      if (!q.ok || q.value.kind !== 'quote') throw new Error(`quote ${i} failed`);
      const t1 = nowMs();
      const g = await app.engine.requestApproval({
        actor,
        selection: { kind: 'quote', quote_id: q.value.quote_id },
        consent: { terms: true, identity_share: false },
      });
      approvalMs.push(msSince(t1));
      if (!g.ok) throw new Error(`approval ${i} failed`);
    }
    return verdict(quoteMs, approvalMs, budgetMs);
  } finally {
    await app.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const n = opt('--n') === undefined ? PERF2_N : Number(opt('--n'));
  const budgetMs = opt('--budget-ms') === undefined ? PERF2_BUDGET_MS : Number(opt('--budget-ms'));
  if (!Number.isInteger(n) || n < 1 || !(budgetMs > 0)) {
    process.stderr.write(
      'perf-offline: --n must be a positive integer, --budget-ms a positive number\n',
    );
    process.exit(2);
  }
  const out = opt('--out') ?? '.data/perf-offline.json';
  const result = await measure({ n, budgetMs });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `PERF-2 offline n=${result.n} quote p95=${result.quote.p95}ms approval p95=${result.approval.p95}ms budget=${budgetMs}ms ${result.ok ? 'OK' : 'FAIL'}\n`,
  );
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
