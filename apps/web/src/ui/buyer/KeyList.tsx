'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteJson, postJson } from '../../lib/client-api';
import { idemFor } from '../../lib/buyer-agents-view';
import {
  KEY_ONCE_NOTE,
  KEY_PRESETS,
  KEY_PRESET_IDS,
  KEY_REFUSAL_WORDS,
  issuedState,
  keyRequest,
} from '../../lib/buyer-keys-view';
import type { IssuedAnswer, KeyPreset, KeysModel } from '../../lib/buyer-keys-view';
import './buyer.css';

// INT-BUY / BUY.8: the key list, a make form and revoke. The secret of a new key is held in this component's state
// only, shown once, and cleared when the buyer presses Done. It is never put in the list, the URL or storage.
export function KeyList({ model, nonce }: { model: KeysModel; nonce: string }) {
  const router = useRouter();
  const [preset, setPreset] = useState<KeyPreset>('agent');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [shown, setShown] = useState<string | null>(null);

  async function make(): Promise<void> {
    setBusy(true);
    setProblem('');
    const body = keyRequest(preset);
    const r = await postJson<IssuedAnswer>('/api/v1/api-keys', body, {
      'idempotency-key': idemFor(nonce, body),
    });
    setBusy(false);
    if (!r.ok) {
      setProblem(KEY_REFUSAL_WORDS[r.code] ?? r.message);
      return;
    }
    setShown(issuedState(r.data).shown.token);
    router.refresh();
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    setProblem('');
    const r = await deleteJson<{ id: string }>(`/api/v1/api-keys/${encodeURIComponent(id)}`, {
      'idempotency-key': `revoke-${nonce}-${id}`.slice(0, 128),
    });
    setBusy(false);
    if (!r.ok) {
      setProblem(KEY_REFUSAL_WORDS[r.code] ?? r.message);
      return;
    }
    router.refresh();
  }

  return (
    <>
      {shown !== null ? (
        <div className="cap-card" role="status" data-testid="key-once">
          <p>{KEY_ONCE_NOTE}</p>
          <p>
            <code data-testid="key-secret">{shown}</code>
          </p>
          <p>
            <button type="button" className="btn" onClick={() => setShown(null)}>
              Done, I copied it
            </button>
          </p>
        </div>
      ) : null}
      {model.empty !== null ? <p data-testid="keys-empty">{model.empty}</p> : null}
      {model.rows.length > 0 ? (
        <table aria-label="Your API keys" data-testid="keys-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">What it can do</th>
              <th scope="col">State</th>
              <th scope="col">Use</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((k) => (
              <tr key={k.id} data-testid="key-row">
                <td>
                  {k.kind_word} {k.id.slice(-4)}
                </td>
                <td>{k.scopes_text}</td>
                <td>
                  {k.state_word}. {k.created_text}.
                </td>
                <td>{k.last_used_text}</td>
                <td>
                  {k.can_revoke ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      aria-label={`Revoke ${k.kind_word} ${k.id.slice(-4)}`}
                      onClick={() => void revoke(k.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form
        aria-label="Make a key"
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
      >
        <p>
          <label htmlFor="key-preset">What kind of key</label>
          <select
            id="key-preset"
            value={preset}
            onChange={(e) => setPreset(e.target.value as KeyPreset)}
          >
            {KEY_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {KEY_PRESETS[id].label}
              </option>
            ))}
          </select>
        </p>
        <p className="muted">{KEY_PRESETS[preset].help}</p>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Make key
        </button>
      </form>
      <div aria-live="polite">{problem !== '' ? <p role="alert">{problem}</p> : null}</div>
    </>
  );
}
