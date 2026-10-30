import type { Metadata } from 'next';
import { REFUNDS_DOC } from '../../../lib/legal-copy';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: REFUNDS_DOC.title };

export default function Page() {
  return <LegalPage doc={REFUNDS_DOC} />;
}
