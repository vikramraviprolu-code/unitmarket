import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EmptyState } from '../../../ui/EmptyState';
import { EnvLabel } from '../../../ui/EnvLabel';
import { Chip, PageHeader, Section } from '../../../ui/publisher/kit';
import { formatDateTime } from '../../../lib/format';
import {
  BATCHES_EMPTY,
  BATCHES_HEADING,
  BATCH_OPEN,
  CODE_HEADING,
  CODE_INSTRUCTION,
  CODE_NOTE,
  DOMAIN_EMPTY,
  DOMAIN_LIST_HEADING,
  DOMAIN_PENDING,
  DOMAIN_VERIFIED_BY_US,
  DOMAIN_VERIFIED,
  IMPORT_HEADING,
  IMPORT_LEDE,
  IMPORT_SAFE_NOTE,
  QUICK_MANUAL,
  batchStateText,
  progressText,
} from '../../../lib/web-import-copy';
import { ImportStart } from './ImportStart';
import { QuickStart } from './QuickStart';
import { RemoveAddress } from './RemoveAddress';
import '../pk-forms.css';

export const metadata: Metadata = { title: 'Add your catalogue' };

// POB-I1 (D-089, J7): prove a web address, then start reading it. POB-Q1: the quick start does both from one
// address; the two steps stay below for a publisher who wants them. The publisher is the one in the session and
// nowhere else; the page reads no input. Every action goes to a route that checks it again.
export default async function PublisherImport() {
  const actor = await currentActor();
  if (actor?.kind !== 'publisher') redirect('/signin?next=/publisher/import');
  const engine = (await app()).engine.webImport;
  const [domains, batches, proof] = await Promise.all([
    engine.domains(actor),
    engine.batches(actor),
    engine.proofCode(actor),
  ]);
  if (domains === null || batches === null || proof === null)
    redirect('/signin?next=/publisher/import');
  return (
    <>
      <PageHeader
        title={IMPORT_HEADING}
        lede={IMPORT_LEDE}
        aside={<EnvLabel environment={batches.environment} />}
      />
      <p className="pk-help">{IMPORT_SAFE_NOTE}</p>
      <Section title={CODE_HEADING} id="import-code">
        <div className="pk-panel" data-testid="import-code">
          <p>{CODE_INSTRUCTION}</p>
          <p>
            <code>{proof.code}</code>
          </p>
          <p className="pk-help">{CODE_NOTE}</p>
        </div>
      </Section>
      <Section title={DOMAIN_LIST_HEADING} id="import-domains">
        {domains.domains.length === 0 ? (
          <p>{DOMAIN_EMPTY}</p>
        ) : (
          <ul className="pk-list">
            {domains.domains.map((d) => (
              <li key={d.host}>
                {d.host}{' '}
                <Chip tone={d.state === 'verified' ? 'good' : 'warn'}>
                  {d.state === 'verified'
                    ? d.verified_by === 'operator'
                      ? DOMAIN_VERIFIED_BY_US
                      : DOMAIN_VERIFIED
                    : DOMAIN_PENDING}
                </Chip>{' '}
                <RemoveAddress host={d.host} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <QuickStart />
      <details>
        <summary>{QUICK_MANUAL}</summary>
        <ImportStart
          pending={domains.domains.filter((d) => d.state === 'pending').map((d) => d.host)}
          verified={domains.domains.filter((d) => d.state === 'verified').map((d) => d.host)}
        />
      </details>
      <Section title={BATCHES_HEADING} id="import-batches">
        {batches.batches.length === 0 ? (
          <EmptyState title={BATCHES_EMPTY}>{BATCHES_EMPTY}</EmptyState>
        ) : (
          <ul className="pk-list">
            {batches.batches.map((b) => (
              <li key={b.id}>
                <Link href={`/publisher/import/${encodeURIComponent(b.id)}`}>{BATCH_OPEN}</Link>{' '}
                {b.source_host} <Chip>{batchStateText(b.state)}</Chip>{' '}
                {progressText(b.done, b.total, b.refused)} {formatDateTime(b.created_at)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
