'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../lib/client-api';
import { formatMinor } from '../../lib/format';
import { REVOKE_REASONS, REVOKE_REASON_WORD, revokeOutcome } from '../../lib/ops-agents-view';
import type { CapRow, RevokeReason } from '../../lib/ops-agents-view';

// INT-OPS-C / OPS-C.3: the caps table of Agents and API and the one revoke form it shares with the keys table.
// A form posts a reason code (never free text) with the single-use key the page made on the server, and says the
// answer in a status region. Without the authenticator code the page passes no key, so no form is drawn.
export function RevokeForm({
  kind,
  id,
  idemKey,
  label,
}: {
  kind: 'cap' | 'key';
  id: string;
  idemKey: string;
  label: string;
}) {
  const router = useRouter();
  const uid = useId();
  const [reason, setReason] = useState<RevokeReason>('abuse');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const path =
    kind === 'cap'
      ? `/api/ops/mandates/${encodeURIComponent(id)}/revoke`
      : `/api/ops/api-keys/${encodeURIComponent(id)}/revoke`;
  async function press() {
    setBusy(true);
    const r = await postJson(path, { reason_code: reason }, { 'idempotency-key': idemKey });
    setBusy(false);
    setSaid(revokeOutcome(r.status));
    if (r.ok) router.refresh();
  }
  return (
    <form
      className="ola-action"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void press();
      }}
    >
      <label htmlFor={`${uid}-reason`} className="visually-hidden">
        Reason
      </label>
      <select
        id={`${uid}-reason`}
        value={reason}
        onChange={(e) => setReason(e.target.value as RevokeReason)}
      >
        {REVOKE_REASONS.map((r) => (
          <option key={r} value={r}>
            {REVOKE_REASON_WORD[r]}
          </option>
        ))}
      </select>
      <button type="submit" className="btn" disabled={busy || said !== null}>
        Revoke
      </button>
      <p role="status" aria-live="polite">
        {said ?? ''}
      </p>
    </form>
  );
}

const money = (v: number | null, currency: string): string =>
  v === null ? 'No limit' : formatMinor(v, currency);
const countText = (v: number | null): string => (v === null ? 'No limit' : String(v));

export function CapTable({
  caps,
  revokeKeys,
}: {
  caps: CapRow[];
  revokeKeys: Record<string, string>;
}) {
  if (caps.length === 0) return <p className="oh-empty">No caps yet.</p>;
  return (
    <div className="pk-table-scroll">
      <table className="pk-table">
        <caption className="visually-hidden">Spending caps</caption>
        <thead>
          <tr>
            <th scope="col">Cap</th>
            <th scope="col">Agent key</th>
            <th scope="col">State</th>
            <th scope="col">Spent</th>
            <th scope="col">Money left</th>
            <th scope="col">Purchases used</th>
            <th scope="col">Purchases left</th>
            <th scope="col">Ends</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {caps.map((c) => (
            <tr key={c.id} data-testid={`cap-${c.id}`}>
              <td className="mono" data-label="Cap">
                {c.id}
              </td>
              <td className="mono" data-label="Agent key">
                {c.agent_key}
              </td>
              <td data-label="State">{c.state}</td>
              <td className="pk-num" data-label="Spent">
                {formatMinor(c.spent_minor, c.currency)}
              </td>
              <td className="pk-num" data-label="Money left">
                {money(c.remaining_total_minor, c.currency)}
              </td>
              <td className="pk-num" data-label="Purchases used">
                {c.used_count}
              </td>
              <td className="pk-num" data-label="Purchases left">
                {countText(c.remaining_count)}
              </td>
              <td data-label="Ends">{c.expires_at.slice(0, 10)}</td>
              <td data-label="Action">
                {revokeKeys[c.id] === undefined ? (
                  c.state === 'revoked' ? (
                    'Revoked'
                  ) : (
                    'Needs your authenticator code'
                  )
                ) : (
                  <RevokeForm
                    kind="cap"
                    id={c.id}
                    idemKey={revokeKeys[c.id]!}
                    label={`Revoke cap ${c.id}`}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
