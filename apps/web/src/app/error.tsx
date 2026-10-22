'use client';
import { ErrorState } from '../ui/ErrorState';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong on our side"
      action={
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
      }
    >
      Nothing was charged because of this page. Please try again in a moment.
    </ErrorState>
  );
}
