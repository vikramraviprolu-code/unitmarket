import type { Metadata } from 'next';
import { PRIVACY_DOC } from '../../../lib/legal-copy';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: PRIVACY_DOC.title };

export default function Page() {
  return <LegalPage doc={PRIVACY_DOC} />;
}
