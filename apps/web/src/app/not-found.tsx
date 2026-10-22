import Link from 'next/link';
import { EmptyState } from '../ui/EmptyState';

export default function NotFound() {
  return (
    <EmptyState
      title="We could not find that page"
      action={
        <Link className="btn" href="/">
          Back to the start
        </Link>
      }
    >
      The link may be old, or it may belong to another account.
    </EmptyState>
  );
}
