import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../server/session';
import { readRulesHistory } from '../../../../composition/ops-rules';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import { formatDateTime } from '../../../../lib/format';
import {
  COL_BY,
  COL_FROM,
  COL_KEY,
  COL_SCOPE,
  COL_SET,
  COL_UNTIL,
  COL_VALUE,
  COL_WHY,
  FILTER_APPLY,
  FILTER_CLEAR,
  FILTER_KEY,
  FILTER_OPERATOR,
  FILTER_SCOPE,
  HISTORY_CAPPED,
  HISTORY_EMPTY,
  HISTORY_HEADING,
  INVALID_FILTER,
  OPERATOR_HIDDEN,
  RULE_LABEL,
  RULES_BACK_LINK,
  SCOPE_LABEL,
  UNTIL_OPEN,
  daysText,
} from '../../../../lib/ops-rules-copy';
import { RULE_KEYS } from '@umsbx/contracts';
import { WRITABLE_SCOPES } from '../../../../lib/ops-rules-view';
import '../../pk-opshome.css';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';

export const metadata: Metadata = { title: HISTORY_HEADING };

// BR-6: every stored setting, newest first, 200 on screen. The filters are a plain GET form: rule, who it
// applies to, and (with the authenticator code) who added it. A filter value that is not a registry value is
// refused in words and lists nothing. Reason text is shown as text, never as markup.
export default async function OpsRulesHistory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/rules/history');
  const read = await readRulesHistory(actor, await searchParams);
  if (read === null) redirect('/signin?next=/ops/rules/history');
  return (
    <>
      <PageHeader title={HISTORY_HEADING} aside={<EnvLabel environment={read.environment} />} />
      <p>
        <Link href="/ops/rules">{RULES_BACK_LINK}</Link>
      </p>
      <Section title={HISTORY_HEADING} id="rules-history">
        <form method="get" action="/ops/rules/history" aria-label="Filter the history">
          <div className="field">
            <label htmlFor="rh-key">{FILTER_KEY}</label>
            <select id="rh-key" name="rule_key" defaultValue={read.filter.rule_key ?? ''}>
              <option value="">All</option>
              {RULE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {RULE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rh-scope">{FILTER_SCOPE}</label>
            <select id="rh-scope" name="scope_kind" defaultValue={read.filter.scope_kind ?? ''}>
              <option value="">All</option>
              {WRITABLE_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          {read.mfa ? (
            <div className="field">
              <label htmlFor="rh-operator">{FILTER_OPERATOR}</label>
              <input
                id="rh-operator"
                name="operator"
                type="text"
                maxLength={200}
                defaultValue={read.filter.operator ?? ''}
              />
            </div>
          ) : null}
          <div className="actions">
            <button type="submit" className="btn">
              {FILTER_APPLY}
            </button>
            <Link className="btn" href="/ops/rules/history">
              {FILTER_CLEAR}
            </Link>
          </div>
        </form>
        {read.invalid.length > 0 ? (
          <p role="alert" data-testid="history-invalid">
            {INVALID_FILTER}
          </p>
        ) : read.rows.length === 0 ? (
          <p className="muted" data-testid="history-empty">
            {HISTORY_EMPTY}
          </p>
        ) : (
          <>
            {read.capped ? (
              <p className="muted" role="status" data-testid="history-capped">
                {HISTORY_CAPPED}
              </p>
            ) : null}
            <table className="pk-table" data-testid="history-table">
              <caption className="visually-hidden">Business rule settings, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">{COL_SET}</th>
                  <th scope="col">{COL_KEY}</th>
                  <th scope="col">{COL_SCOPE}</th>
                  <th scope="col">{COL_VALUE}</th>
                  <th scope="col">{COL_FROM}</th>
                  <th scope="col">{COL_UNTIL}</th>
                  <th scope="col">{COL_BY}</th>
                  <th scope="col">{COL_WHY}</th>
                </tr>
              </thead>
              <tbody>
                {read.rows.map((r) => (
                  <tr key={r.id} data-testid="history-row">
                    <td className="pk-nowrap" data-label={COL_SET}>
                      {formatDateTime(r.at)}
                    </td>
                    <td data-label={COL_KEY}>{r.label}</td>
                    <td data-label={COL_SCOPE}>
                      {r.scope_label}
                      {r.scope_id === null ? null : <div className="mono muted">{r.scope_id}</div>}
                    </td>
                    <td data-label={COL_VALUE}>{daysText(r.value)}</td>
                    <td className="pk-nowrap" data-label={COL_FROM}>
                      {formatDateTime(r.from)}
                    </td>
                    <td className="pk-nowrap" data-label={COL_UNTIL}>
                      {r.until === null ? UNTIL_OPEN : formatDateTime(r.until)}
                    </td>
                    <td data-label={COL_BY}>{r.by ?? OPERATOR_HIDDEN}</td>
                    <td data-label={COL_WHY}>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>
    </>
  );
}
