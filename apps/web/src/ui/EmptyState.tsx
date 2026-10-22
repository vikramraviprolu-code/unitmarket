import type { ReactNode } from 'react';

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty" data-testid="empty-state">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action ? <div className="actions">{action}</div> : null}
    </div>
  );
}
