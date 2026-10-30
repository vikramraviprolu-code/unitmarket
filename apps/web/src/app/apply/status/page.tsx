import type { Metadata } from 'next';
import Link from 'next/link';
import { app } from '../../../server/access';
import {
  STATUS_BACK,
  STATUS_BUTTON,
  STATUS_FIELD,
  STATUS_LEDE,
  STATUS_NO_REF,
  STATUS_TITLE,
  statusText,
  statusTone,
} from '../../../lib/apply-copy';
import { Chip, PageHeader } from '../../../ui/publisher/kit';
import '../../publisher/publisher.css';
import '../apply.css';

export const metadata: Metadata = { title: STATUS_TITLE, referrer: 'no-referrer' };

// PUB-APPLY: where an application stands, from the reference alone. Public and read only: the engine answers
// pending, approved, rejected or unknown and nothing else. No account is looked up and no cookie is read.
export default async function ApplyStatus({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const raw = q['ref'];
  const ref = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100) ?? '';
  const state = ref === '' ? null : await (await app()).engine.applicationStatus({ ref });
  return (
    <div className="apply-wrap" data-testid="apply-status-page">
      <PageHeader title={STATUS_TITLE} lede={STATUS_LEDE} />
      <form className="pk-panel apply-stack" method="get" action="/apply/status">
        <div className="field">
          <label htmlFor="status-ref">{STATUS_FIELD}</label>
          <input
            id="status-ref"
            name="ref"
            type="text"
            maxLength={100}
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={ref}
          />
        </div>
        <div>
          <button className="btn btn-primary" type="submit">
            {STATUS_BUTTON}
          </button>
        </div>
      </form>
      {state === null ? (
        <p className="muted" data-testid="apply-status-empty">
          {STATUS_NO_REF}
        </p>
      ) : (
        <p data-testid="apply-status">
          <Chip tone={statusTone(state)} testId="apply-status-chip">
            {statusText(state)}
          </Chip>
        </p>
      )}
      <p>
        <Link href="/apply">{STATUS_BACK}</Link>
      </p>
    </div>
  );
}
