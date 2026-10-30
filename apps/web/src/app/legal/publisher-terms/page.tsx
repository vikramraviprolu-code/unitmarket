import type { Metadata } from 'next';
import { PUBLISHER_TERMS_DOC } from '../../../lib/legal-copy';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: PUBLISHER_TERMS_DOC.title };

export default function Page() {
  return <LegalPage doc={PUBLISHER_TERMS_DOC} />;
}
