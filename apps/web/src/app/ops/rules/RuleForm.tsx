'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson } from '../../../lib/client-api';
import {
  CATEGORY_NOTE,
  FIELD_FROM,
  FIELD_REASON,
  FIELD_RULE,
  FIELD_SCOPE,
  FIELD_SCOPE_ID,
  FIELD_UNTIL,
  FIELD_VALUE,
  HINT_REASON,
  HINT_SCOPE_ID,
  HINT_TIME,
  HINT_UNTIL,
  MFA_NOTICE,
  SAVED_LINE,
  SIGN_IN_AGAIN,
  SUBMIT_LABEL,
  VALUE_ERROR,
  impactLine,
  rangeText,
} from '../../../lib/ops-rules-copy';
import type { NewRulePageRead } from '../../../composition/ops-rules';
import { ErrorState } from '../../../ui/ErrorState';

// BR-6: the form of a new business rule setting. It carries what the operator typed to POST /api/ops/rules (BR-2),
// the one write path, with the Idempotency-Key the server made for this page. The route and the domain check the
// second factor, the safe range, the scope id and the platform ceiling again; this form only says, before submit,
// what the change will do ("Applies to new sales from <date>. Sales already approved keep their terms."). After
// an answer the page is re-read, which brings a fresh key, so a second click cannot add the setting twice.

type Rule = NewRulePageRead['rules'][number];

// `datetime-local` holds "YYYY-MM-DDTHH:MM" and is read as UTC here, as the hint says.
const toIso = (local: string): string => (local.length === 16 ? `${local}:00.000Z` : `${local}Z`);

export function RuleForm({
  rules,
  idempotencyKey,
  defaultFrom,
  hasCode,
}: {
  rules: Rule[];
  idempotencyKey: string;
  /** The start the server offers, a full ISO time. Sent as is until the operator changes the field. */
  defaultFrom: string;
  hasCode: boolean;
}) {
  const router = useRouter();
  const [ruleKey, setRuleKey] = useState(rules[0]!.key);
  const rule = rules.find((r) => r.key === ruleKey) ?? rules[0]!;
  const [scopeKind, setScopeKind] = useState('platform');
  const scope = rule.scopes.some((s) => s.kind === scopeKind) ? scopeKind : 'platform';
  const [scopeId, setScopeId] = useState('');
  const [value, setValue] = useState('');
  const [from, setFrom] = useState(defaultFrom.slice(0, 16));
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fromIso = from === defaultFrom.slice(0, 16) ? defaultFrom : toIso(from);
  const days = Number(value);
  const valueOk =
    value.trim() !== '' && Number.isInteger(days) && days >= rule.min && days <= rule.max;
  const ready =
    hasCode &&
    !busy &&
    valueOk &&
    from !== '' &&
    reason.trim().length >= 3 &&
    (scope === 'platform' || scopeId.trim() !== '');

  async function save() {
    if (!valueOk) {
      setError(VALUE_ERROR);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await postJson<{ id: string }>(
      '/api/ops/rules',
      {
        rule_key: rule.key,
        scope_kind: scope,
        scope_id: scope === 'platform' ? null : scopeId.trim(),
        value: days,
        effective_from: fromIso,
        effective_until: until === '' ? null : toIso(until),
        reason: reason.trim(),
      },
      { 'idempotency-key': idempotencyKey },
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? SIGN_IN_AGAIN : r.message);
      return;
    }
    setDone(SAVED_LINE);
    setValue('');
    setReason('');
    setScopeId('');
    // A fresh page brings a fresh key: the one used here is spent.
    router.refresh();
  }

  return (
    <form
      aria-label="Add a business rule setting"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor="rule-key">{FIELD_RULE}</label>
        <select id="rule-key" value={rule.key} onChange={(e) => setRuleKey(e.target.value)}>
          {rules.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <span className="muted"> {rule.hint}</span>
      </div>
      <div className="field">
        <label htmlFor="rule-scope">{FIELD_SCOPE}</label>
        <select id="rule-scope" value={scope} onChange={(e) => setScopeKind(e.target.value)}>
          {rule.scopes.map((s) => (
            <option key={s.kind} value={s.kind}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {scope === 'platform' ? null : (
        <div className="field">
          <label htmlFor="rule-scope-id">{FIELD_SCOPE_ID}</label>
          <input
            id="rule-scope-id"
            type="text"
            maxLength={200}
            value={scopeId}
            aria-describedby="rule-scope-id-hint"
            onChange={(e) => setScopeId(e.target.value)}
          />
          <span id="rule-scope-id-hint" className="muted">
            {HINT_SCOPE_ID}
            {scope === 'category' ? ` ${CATEGORY_NOTE}` : ''}
          </span>
        </div>
      )}
      <div className="field">
        <label htmlFor="rule-value">{FIELD_VALUE}</label>
        <input
          id="rule-value"
          type="number"
          inputMode="numeric"
          min={rule.min}
          max={rule.max}
          step={1}
          value={value}
          aria-describedby="rule-value-hint"
          onChange={(e) => setValue(e.target.value)}
        />
        <span id="rule-value-hint" className="muted">
          {rangeText(rule.min, rule.max)}
        </span>
      </div>
      <div className="field">
        <label htmlFor="rule-from">{FIELD_FROM}</label>
        <input
          id="rule-from"
          type="datetime-local"
          value={from}
          aria-describedby="rule-time-hint"
          onChange={(e) => setFrom(e.target.value)}
        />
        <span id="rule-time-hint" className="muted">
          {HINT_TIME}
        </span>
      </div>
      <div className="field">
        <label htmlFor="rule-until">{FIELD_UNTIL}</label>
        <input
          id="rule-until"
          type="datetime-local"
          value={until}
          aria-describedby="rule-until-hint"
          onChange={(e) => setUntil(e.target.value)}
        />
        <span id="rule-until-hint" className="muted">
          {HINT_UNTIL}
        </span>
      </div>
      <div className="field">
        <label htmlFor="rule-reason">{FIELD_REASON}</label>
        <input
          id="rule-reason"
          type="text"
          maxLength={200}
          value={reason}
          aria-describedby="rule-reason-hint"
          onChange={(e) => setReason(e.target.value)}
        />
        <span id="rule-reason-hint" className="muted">
          {HINT_REASON}
        </span>
      </div>
      <p role="status" data-testid="rules-impact">
        {impactLine(from === '' ? null : fromIso)}
      </p>
      <div className="actions">
        <button type="submit" className="btn" disabled={!ready} data-testid="rules-save">
          {SUBMIT_LABEL}
        </button>
        {hasCode ? null : <span className="muted"> {MFA_NOTICE}</span>}
      </div>
      <div aria-live="polite" data-testid="rules-answer">
        {done === null ? null : <p>{done}</p>}
      </div>
      {error === null ? null : <ErrorState title="Could not save the setting">{error}</ErrorState>}
    </form>
  );
}
