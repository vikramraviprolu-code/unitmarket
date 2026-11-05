'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { postJson } from '../../lib/client-api';
import { CAP_REFUSAL_WORDS } from '../../lib/buyer-agents-view';
import type { AgentRow } from '../../lib/buyer-agents-view';
import { SpendMeter } from './SpendMeter';
import './buyer.css';

// INT-BUY / BUY.1: one agent key and its newest cap. It paints what lib/buyer-agents-view.ts returns. Revoke ends
// the cap (POST /api/buyer/mandates/{id}/revoke with an empty body). The state is said in words.
export function CapCard({ row, nonce }: { row: AgentRow; nonce: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const card = row.cap;

  async function revoke(): Promise<void> {
    if (card === null) return;
    setBusy(true);
    setProblem('');
    const r = await postJson<{ id: string }>(
      `/api/buyer/mandates/${encodeURIComponent(card.id)}/revoke`,
      {},
      { 'idempotency-key': `revoke-${nonce}-${card.id}`.slice(0, 128) },
    );
    setBusy(false);
    if (!r.ok) {
      setProblem(CAP_REFUSAL_WORDS[r.code] ?? r.message);
      return;
    }
    router.refresh();
  }

  return (
    <li className="cap-card" data-testid="cap-card">
      <h3>{row.key_label}</h3>
      {card === null ? (
        <p data-testid="cap-none">No cap yet. This agent cannot buy until you give it one.</p>
      ) : (
        <>
          <p>
            <span className="cap-state" data-testid="cap-state">
              {card.state_word}
            </span>
            . {card.until_text}.
            {card.per_purchase_text !== null ? ` ${card.per_purchase_text}.` : ''}
          </p>
          <SpendMeter card={card} label={`Spending of ${row.key_label}`} />
          {card.can_revoke ? (
            <p>
              <button
                type="button"
                className="btn"
                onClick={() => void revoke()}
                disabled={busy}
                aria-label={`End the cap of ${row.key_label}`}
              >
                End this cap
              </button>
            </p>
          ) : null}
        </>
      )}
      <div aria-live="polite">{problem !== '' ? <p role="alert">{problem}</p> : null}</div>
    </li>
  );
}
