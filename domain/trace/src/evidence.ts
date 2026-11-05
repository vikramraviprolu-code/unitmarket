// INT-TR1 / TR1.5: the evidence pack of one unit. The events of the order chain from seq 1 to the head a seal
// names (or to the current head), each with its canon text and row hash, so a checker with only a SHA-256
// tool recomputes every hash and link without Postgres. The canon comes from TR0's trace_canon in SQL: no
// hashing happens in this file. The source rows are an allow-list of tables and columns; nothing with a name,
// an email, an address, a User-Agent or free text is ever read here. The buyer id is only the opaque id that
// sits inside the canon text. Operators with the second factor only (the route enforces it).
import type { SqlExecutor } from '@umsbx/contracts';

export const SOURCE_ROW_TABLES = [
  'order_units',
  'ledger_entries',
  'receipts',
  'entitlements',
  'access_events',
  'refund_requests',
  'provider_calls',
] as const;
type SourceTable = (typeof SOURCE_ROW_TABLES)[number];

export interface EvidenceEvent {
  seq: number;
  occurred_at: string;
  event_type: string;
  canon: string;
  row_hash: string;
}

export interface EvidencePack {
  unit_id: string;
  order_ref: string;
  events: EvidenceEvent[];
  chain: { key: string; from_seq: number; to_seq: number };
  sealed: boolean;
  seal?: {
    day: string;
    at: string;
    root_hash: string;
    prev_root_hash: string;
    head: { chain_key: string; seq: number; row_hash: string };
  };
  source_rows: Record<SourceTable, Record<string, unknown>[]>;
  verify_steps: string[];
}

export const VERIFY_STEPS: readonly string[] = [
  'For each event, take the canon text as UTF-8 and compute its SHA-256 in hex. It must equal row_hash.',
  'Parse the canon text as JSON. Its chain_key must be the chain of this pack and its seq must be the seq of the event. The seqs run 1, 2, 3 with no gap.',
  'The prev_hash inside each canon text must equal the row_hash of the event before it. For the first event it is 64 zeros.',
  'If sealed is true, the last event must equal seal.head in chain_key, seq and row_hash. The seal is labelled sealed through its time: it covers every row up to the heads it holds, not one calendar day.',
  'The seal root covers all chains, so it cannot be recomputed from one pack. Ask the operator to run pnpm trace:verify to recompute it.',
];

export async function evidencePack(
  db: SqlExecutor,
  o: { unit_id: string },
): Promise<EvidencePack | null> {
  const u = (
    await db.query<{ order_id: string; order_ref: string }>(
      `SELECT u.order_id, o.order_ref FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1`,
      [o.unit_id],
    )
  ).rows[0];
  if (u === undefined) return null;
  const key = `ord:${u.order_id}`;
  const seal = (
    await db.query<{
      day: string;
      at: string;
      root_hash: string;
      prev_root_hash: string;
      seq: number;
      row_hash: string;
    }>(
      `SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
              to_char(s.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
              s.root_hash, s.prev_root_hash, (h.elem ->> 'seq')::int AS seq, h.elem ->> 'row_hash' AS row_hash
         FROM trace_seals s CROSS JOIN LATERAL jsonb_array_elements(s.heads) AS h(elem)
        WHERE h.elem ->> 'chain_key' = $1 ORDER BY s.id DESC LIMIT 1`,
      [key],
    )
  ).rows[0];
  const events = (
    await db.query<EvidenceEvent>(
      `SELECT e.seq::int AS seq,
              to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
              e.event_type, trace_canon(e) AS canon, e.row_hash
         FROM trace_events e WHERE e.chain_key = $1 AND ($2::int IS NULL OR e.seq <= $2::int) ORDER BY e.seq`,
      [key, seal?.seq ?? null],
    )
  ).rows;
  const q = async (sql: string, p: unknown[]): Promise<Record<string, unknown>[]> =>
    (await db.query<Record<string, unknown>>(sql, p)).rows;
  const source_rows: EvidencePack['source_rows'] = {
    order_units: await q(
      'SELECT id, status, amount_minor::int AS amount_minor, platform_fee_minor::int AS platform_fee_minor, refunded_minor::int AS refunded_minor FROM order_units WHERE id = $1',
      [o.unit_id],
    ),
    ledger_entries: await q(
      'SELECT id, kind, amount_minor::int AS amount_minor, currency FROM ledger_entries WHERE unit_id = $1 ORDER BY created_at, id',
      [o.unit_id],
    ),
    receipts: await q('SELECT version, sha256 FROM receipts WHERE order_id = $1 ORDER BY version', [
      u.order_id,
    ]),
    entitlements: await q(
      'SELECT money_state, access_state, licence_state FROM entitlements WHERE unit_id = $1 ORDER BY id',
      [o.unit_id],
    ),
    access_events: await q(
      `SELECT a.kind, to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM access_events a JOIN entitlements n ON n.id = a.entitlement_id
        WHERE n.unit_id = $1 ORDER BY a.at, a.id`,
      [o.unit_id],
    ),
    refund_requests: await q(
      'SELECT id, amount_minor::int AS amount_minor, currency, state FROM refund_requests WHERE unit_id = $1 ORDER BY created_at, id',
      [o.unit_id],
    ),
    provider_calls: await q(
      `SELECT c.operation, c.method, c.http_status, c.outcome, c.transport_kind
         FROM provider_calls c JOIN operations x ON x.id = c.operation_id
        WHERE x.order_id = $1 ORDER BY c.created_at, c.id`,
      [u.order_id],
    ),
  };
  const last = events.at(-1);
  const pack: EvidencePack = {
    unit_id: o.unit_id,
    order_ref: u.order_ref,
    events,
    chain: { key, from_seq: 1, to_seq: last?.seq ?? 0 },
    sealed: seal !== undefined,
    source_rows,
    verify_steps: [...VERIFY_STEPS],
  };
  if (seal !== undefined)
    pack.seal = {
      day: seal.day,
      at: seal.at,
      root_hash: seal.root_hash,
      prev_root_hash: seal.prev_root_hash,
      head: { chain_key: key, seq: seal.seq, row_hash: seal.row_hash },
    };
  return pack;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The same pack as a printable page. The canon text is the only place an id of the buyer can show. */
export function evidenceHtml(p: EvidencePack): string {
  const seal =
    p.seal === undefined
      ? 'Not sealed yet. The events run to the current head of the chain.'
      : `Sealed through ${esc(p.seal.at)} (seal ${esc(p.seal.day)}). Root ${esc(p.seal.root_hash)}.`;
  const rows = p.events
    .map(
      (e) =>
        `<li data-seq="${e.seq}" data-hash="${esc(e.row_hash)}"><p><strong>Step ${e.seq}</strong> ${esc(e.event_type)} at ${esc(e.occurred_at)}</p><p class="hash">${esc(e.row_hash)}</p><pre class="canon">${esc(e.canon)}</pre></li>`,
    )
    .join('\n');
  const steps = p.verify_steps.map((s) => `<li>${esc(s)}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence for unit ${esc(p.unit_id)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 56rem; padding: 1rem 16px; color: #111; background: #fff; }
.hash, pre { font-family: ui-monospace, monospace; font-size: 0.8rem; word-break: break-all; white-space: pre-wrap; }
li { margin-bottom: 1rem; break-inside: avoid; }
@media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } }
@media print { body { color: #000; background: #fff; } }
</style>
</head>
<body>
<h1>Evidence for unit ${esc(p.unit_id)}</h1>
<p>Order ${esc(p.order_ref)}. Chain ${esc(p.chain.key)}, steps ${p.chain.from_seq} to ${p.chain.to_seq}.</p>
<p>${seal}</p>
<h2>How to check this page</h2>
<ol>
${steps}
</ol>
<h2>Events</h2>
<ol>
${rows}
</ol>
</body>
</html>
`;
}
