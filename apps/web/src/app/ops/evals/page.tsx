import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EnvLabel } from '../../../ui/EnvLabel';
import {
  CLAUDE_CELL_COUNTS_ONLY,
  CLAUDE_CELL_NOT_RUN,
  CLAUDE_NOT_RUN_NOTE,
  COL_BASELINE,
  COL_CASE,
  COL_CLAUDE,
  COL_KIND,
  EVALS_BACK_LINK,
  EVALS_HEADING,
  EVALS_LEDE,
  EVALS_TABLE_HEADING,
  EVALS_WHAT,
  EVALS_WHAT_HEADING,
  MODEL_NOTE,
  baselineLine,
  casesLine,
  claudeLine,
  kindText,
  modelInUseLine,
  verdictText,
} from '../../../lib/evals-copy';

export const metadata: Metadata = { title: 'Model evaluation' };

// Operator only. Computed on the server from the committed cases and the scripted model; no network
// call, no key. The rows hold an id, a kind and a verdict made of fixed codes, never model text.
export default async function Evals() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/evals');
  const s = await (await app()).engine.evalsSummary(actor);
  if (s === null) redirect('/signin?next=/ops/evals');
  return (
    <>
      <h1>
        {EVALS_HEADING} <EnvLabel environment={s.environment} />
      </h1>
      <p className="muted">{EVALS_LEDE}</p>
      <p>
        <Link href="/ops">{EVALS_BACK_LINK}</Link>
      </p>

      <ul data-testid="evals-summary">
        <li data-testid="evals-cases">
          {casesLine(s.baseline.total, s.listing_cases, s.brief_cases)}
        </li>
        <li data-testid="evals-baseline">{baselineLine(s.baseline)}</li>
        <li data-testid="evals-claude">{claudeLine(s.claude, s.baseline.total)}</li>
        <li data-testid="evals-model">{modelInUseLine(s.model_in_use)}</li>
      </ul>
      {s.claude.state === 'not_run' ? <p className="muted">{CLAUDE_NOT_RUN_NOTE}</p> : null}
      <p className="muted">{MODEL_NOTE}</p>

      <h2>{EVALS_WHAT_HEADING}</h2>
      {EVALS_WHAT.map((p, i) => (
        <p key={i}>{p}</p>
      ))}

      <h2>{EVALS_TABLE_HEADING}</h2>
      <div className="table-scroll" role="region" aria-label={EVALS_TABLE_HEADING} tabIndex={0}>
        <table>
          <caption className="visually-hidden">{EVALS_TABLE_HEADING}</caption>
          <thead>
            <tr>
              <th scope="col">{COL_CASE}</th>
              <th scope="col">{COL_KIND}</th>
              <th scope="col">{COL_BASELINE}</th>
              <th scope="col">{COL_CLAUDE}</th>
            </tr>
          </thead>
          <tbody>
            {s.cases.map((c) => (
              <tr key={c.id} data-testid={`evals-row-${c.id}`}>
                <td className="mono">{c.id}</td>
                <td>{kindText(c.kind)}</td>
                <td>{verdictText(c)}</td>
                <td>
                  {s.claude.state === 'recorded' ? CLAUDE_CELL_COUNTS_ONLY : CLAUDE_CELL_NOT_RUN}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
