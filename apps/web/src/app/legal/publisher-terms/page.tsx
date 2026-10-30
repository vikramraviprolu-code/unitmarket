import type { Metadata } from 'next';
import Link from 'next/link';
import { LINK_APPLY, TERMS_APPLY_LEAD } from '../../../lib/apply-copy';
import { PUBLISHER_TERMS_DOC } from '../../../lib/legal-copy';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: PUBLISHER_TERMS_DOC.title };

export default function Page() {
  return (
    <>
      <LegalPage doc={PUBLISHER_TERMS_DOC} />
      <p className="muted" data-testid="terms-apply">
        {TERMS_APPLY_LEAD} <Link href="/apply">{LINK_APPLY}</Link>
      </p>
    </>
  );
}
