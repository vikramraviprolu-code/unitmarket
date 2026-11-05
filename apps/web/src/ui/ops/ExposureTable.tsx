'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EXPOSURE_REASON_CODES } from '@umsbx/contracts';
import { postJson } from '../../lib/client-api';
import type { ExposureLine } from '../../lib/exposure-view';
import { Chip } from '../publisher/kit';

// INT-CTL / CTL.7: the API groups as a table, one toggle per group. State is written in words. Off needs no
// authenticator code; on does, and the server says so when the session has none.
const REASON_WORDS: Record<string, string> = {
  incident: 'Incident',
  partner_request: 'Partner request',
  maintenance: 'Maintenance',
  other: 'Other',
};

export function ExposureTable({ lines, keys }: { lines: ExposureLine[]; keys: string[] }) {
  const router = useRouter();
  const [reason, setReason] = useState<string>('incident');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  async function toggle(line: ExposureLine, key: string) {
    setBusy(line.group);
    const r = await postJson(line.toggle.path, { reason_code: reason }, { 'idempotency-key': key });
    setBusy(null);
    if (r.ok) {
      setMessage(`${line.label} is now ${line.toggle.action}.`);
      router.refresh();
    } else {
      setMessage(r.message);
    }
  }
  return (
    <div>
      <p>
        <label htmlFor="exposure-reason">Reason for the change</label>{' '}
        <select id="exposure-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {EXPOSURE_REASON_CODES.map((c) => (
            <option key={c} value={c}>
              {REASON_WORDS[c] ?? c}
            </option>
          ))}
        </select>
      </p>
      <table data-testid="exposure-table">
        <caption>API groups open to partners</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">State</th>
            <th scope="col">Last change</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.group} data-testid={`exposure-${l.group}`}>
              <th scope="row">
                {l.label} <span className="oh-code">{l.group}</span>
              </th>
              <td>
                <Chip tone={l.state === 'on' ? 'good' : 'warn'}>
                  {l.state === 'on' ? 'On' : 'Off'}
                </Chip>
              </td>
              <td>
                {l.last_change === null
                  ? 'Never changed'
                  : `${l.last_change.by}, ${l.last_change.at}${l.last_change.reason_code === null ? '' : `, ${l.last_change.reason_code}`}`}
              </td>
              <td>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Turn ${l.group} ${l.toggle.action}`}
                  disabled={busy !== null}
                  onClick={() => void toggle(l, keys[i] ?? '')}
                >
                  Turn {l.toggle.action}
                </button>
                {l.toggle.needs_mfa ? (
                  <span className="oh-hint"> Needs your authenticator code.</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p role="status" data-testid="exposure-result">
        {message}
      </p>
    </div>
  );
}
