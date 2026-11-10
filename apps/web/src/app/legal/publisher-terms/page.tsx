import type { Metadata } from 'next';
import Link from 'next/link';
import { LINK_APPLY, TERMS_APPLY_LEAD } from '../../../lib/apply-copy';
import { PUBLISHER_TERMS_DOC, publisherTermsDoc } from '../../../lib/legal-copy';
import { app } from '../../../server/access';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: PUBLISHER_TERMS_DOC.title };

// JR-1: the days are the access window in force now, read once per request, not a constant.
export default async function Page() {
  const days = await (await app()).engine.platformAccessDays();
  return (
    <>
      <LegalPage doc={publisherTermsDoc(days)} />
      <p className="muted" data-testid="terms-apply">
        {TERMS_APPLY_LEAD} <Link href="/apply">{LINK_APPLY}</Link>
      </p>
    </>
  );
}
