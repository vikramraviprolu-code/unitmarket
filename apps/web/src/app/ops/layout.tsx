import type { ReactNode } from 'react';
import '../publisher/publisher.css';
import '../publisher/pk-ops.css';

// PUB-UI-OPS: loads the publisher kit styles for every operator route (/ops, /ops/publishers, /ops/payee-requests).
export default function OpsLayout({ children }: { children: ReactNode }) {
  return children;
}
