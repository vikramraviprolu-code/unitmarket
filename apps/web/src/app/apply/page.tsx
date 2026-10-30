import type { Metadata } from 'next';
import { APPLY_LEDE, APPLY_TITLE } from '../../lib/apply-copy';
import { PageHeader } from '../../ui/publisher/kit';
import { ApplyForm } from './ApplyForm';
import '../publisher/publisher.css';
import './apply.css';

export const metadata: Metadata = { title: APPLY_TITLE, referrer: 'no-referrer' };

// PUB-APPLY: public, no sign in. It reads nothing from the database and sets no cookie.
export default function Apply() {
  return (
    <div className="apply-wrap" data-testid="apply-page">
      <PageHeader title={APPLY_TITLE} lede={APPLY_LEDE} />
      <ApplyForm />
    </div>
  );
}
