import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../server/session';
import { app } from '../../../server/access';
import { readRulesIndex } from '../../../composition/ops-rules';
import { EnvLabel } from '../../../ui/EnvLabel';
import { Chip, PageHeader, Section } from '../../../ui/publisher/kit';
import {
  COL_APPLIES,
  COL_BUYERS,
  COL_LAST,
  COL_NOW,
  COL_RANGE,
  COL_RULE,
  COL_SELLERS,
  NO_CHANGE_YET,
  RULE_HINT,
  RULES_EXPLAIN_LINK,
  RULES_HISTORY_LINK,
  RULES_LEDE,
  RULES_NEW_LINK,
  RULES_TITLE,
  SCOPE_LABEL,
  SOURCE_DEFAULT_NOTE,
  daysText,
  inForceLine,
  lastChangeText,
  rangeText,
} from '../../../lib/ops-rules-copy';
import { DownloadRules } from './DownloadRules';
import '../pk-opshome.css';
import '../../tables.css';
import '../../publisher/pk-sales.css';

export const metadata: Metadata = { title: RULES_TITLE };

// BR-6: one row per business rule: the platform value now, the safe range, where it can be set, how many sellers
// and buyers have their own value, and the last change. It only reads; changes are made on /ops/rules/new, which
// posts to the BR-2 route. Without the authenticator code the page is still readable and the last change does not
// name the operator.
export default async function OpsRules() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/rules');
  const read = await readRulesIndex(actor);
  if (read === null) redirect('/signin?next=/ops/rules');
  const inForce = await (await app()).engine.platformAccessDays();
  return (
    <>
      <PageHeader
        title={RULES_TITLE}
        lede={RULES_LEDE}
        aside={
          <>
            <EnvLabel environment={read.environment} />
            <Link className="btn" href="/ops/rules/new">
              {RULES_NEW_LINK}
            </Link>
          </>
        }
      />
      <Section title={RULES_TITLE} id="rules-list">
        <table className="pk-table" data-testid="rules-table">
          <caption className="visually-hidden">Business rules and their current values</caption>
          <thead>
            <tr>
              <th scope="col">{COL_RULE}</th>
              <th scope="col">{COL_NOW}</th>
              <th scope="col">{COL_RANGE}</th>
              <th scope="col">{COL_APPLIES}</th>
              <th scope="col">{COL_SELLERS}</th>
              <th scope="col">{COL_BUYERS}</th>
              <th scope="col">{COL_LAST}</th>
            </tr>
          </thead>
          <tbody>
            {read.rows.map((r) => (
              <tr key={r.key} data-testid="rule-row">
                <td data-label={COL_RULE}>
                  <strong>{r.label}</strong>
                  <div className="muted">{RULE_HINT[r.key]}</div>
                </td>
                <td data-label={COL_NOW}>
                  {daysText(r.platform_value)}{' '}
                  {r.platform_source === 'default' ? (
                    <Chip tone="neutral">{SOURCE_DEFAULT_NOTE}</Chip>
                  ) : null}
                  {r.key === 'access.window' && inForceLine(inForce, r.platform_value) !== null ? (
                    <div className="muted" data-testid="access-in-force">
                      {inForceLine(inForce, r.platform_value)}
                    </div>
                  ) : null}
                </td>
                <td data-label={COL_RANGE}>{rangeText(r.min, r.max)}</td>
                <td data-label={COL_APPLIES}>{r.scopes.map((s) => SCOPE_LABEL[s]).join(', ')}</td>
                <td className="pk-num" data-label={COL_SELLERS}>
                  {r.seller_overrides}
                </td>
                <td className="pk-num" data-label={COL_BUYERS}>
                  {r.buyer_overrides}
                </td>
                <td data-label={COL_LAST}>
                  {r.last_change === null
                    ? NO_CHANGE_YET
                    : lastChangeText(r.last_change.at, r.last_change.by, r.last_change.reason)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="actions">
          <Link className="btn" href="/ops/rules/history">
            {RULES_HISTORY_LINK}
          </Link>
          <Link className="btn" href="/ops/rules/explain">
            {RULES_EXPLAIN_LINK}
          </Link>
          <DownloadRules />
        </p>
      </Section>
    </>
  );
}
