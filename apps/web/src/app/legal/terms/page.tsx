import type { Metadata } from 'next';
import { TERMS_DOC, termsDoc } from '../../../lib/legal-copy';
import { app } from '../../../server/access';
import { LegalPage } from '../../../ui/LegalPage';

export const metadata: Metadata = { title: TERMS_DOC.title };

// JR-1: the days are the access window in force now, read once per request, not a constant.
export default async function Page() {
  const days = await (await app()).engine.platformAccessDays();
  return <LegalPage doc={termsDoc(days)} />;
}
