// T10 (SKIN-B): the skeleton bar is shown with the status line only while a request is pending, so
// the shimmer is never decoration. Screen readers get the status line; the bar is hidden from them.
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <>
      <p className="loading" role="status">
        <span className="spinner" aria-hidden="true" /> {label}
      </p>
      <div className="skeleton" aria-hidden="true" />
    </>
  );
}
