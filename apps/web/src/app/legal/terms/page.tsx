import type { Metadata } from 'next';
import { TERMS_DOC } from '../../../lib/legal-copy';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: TERMS_DOC.title };

export default function Page() {
  return <LegalPage doc={TERMS_DOC} />;
}
