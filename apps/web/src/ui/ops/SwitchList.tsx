'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EXPOSURE_REASON_CODES } from '@umsbx/contracts';
import { postJson } from '../../lib/client-api';
import type { SwitchLine } from '../../lib/switches-view';
import { Chip } from '../publisher/kit';

// INT-CTL / CTL.3: the safety switches with a toggle each. Off is open to any operator session; on needs the
// authenticator code, and the server says so when the session has none. PayPal outbound shows no "on" button.
const REASON_WORDS: Record<string, string> = {
  incident: 'Incident',
  partner_request: 'Partner request',
  maintenance: 'Maintenance',
  other: 'Other',
};

export function SwitchList({ lines, keys }: { lines: SwitchLine[]; keys: string[] }) {
  const router = useRouter();
  const [reason, setReason] = useState<string>('incident');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  async function toggle(line: SwitchLine, key: string) {
    if (line.toggle === null) return;
    setBusy(line.name);
    // Agent buying has its own route, which takes a yes or no and the reason in words (OPS-SW).
    const body =
      line.toggle.body === 'agent_buy'
        ? { on: line.toggle.action === 'on', reason: REASON_WORDS[reason] ?? reason }
        : { reason_code: reason };
    const r = await postJson(line.toggle.path, body, { 'idempotency-key': key });
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
        <label htmlFor="switch-reason">Reason for the change</label>{' '}
        <select id="switch-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {EXPOSURE_REASON_CODES.map((c) => (
            <option key={c} value={c}>
              {REASON_WORDS[c] ?? c}
            </option>
          ))}
        </select>
      </p>
      <ul className="oh-grid" aria-label="Safety switches">
        {lines.map((l, i) => (
          <li key={l.name}>
            <div className="pk-panel oh-switch" data-testid={`ops-switch-${l.name}`}>
              <p className="oh-switch-name">{l.label}</p>
              <p className="oh-code">{l.name}</p>
              <Chip tone={l.chip.tone}>{l.chip.text}</Chip>
              {l.hint ? <p className="oh-hint">{l.hint}</p> : null}
              {l.toggle !== null ? (
                <button
                  type="button"
                  className="btn"
                  aria-label={`Turn ${l.label} ${l.toggle.action}`}
                  disabled={busy !== null}
                  onClick={() => void toggle(l, keys[i] ?? '')}
                >
                  Turn {l.toggle.action}
                </button>
              ) : null}
              {l.note !== null ? <p className="oh-hint">{l.note}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      <p role="status" data-testid="switch-result">
        {message}
      </p>
    </div>
  );
}
