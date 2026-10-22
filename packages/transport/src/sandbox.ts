import type { Transport } from '@umsbx/contracts';

// MVP-A: sealed stub. The real HTTPS client is lane B-L1 (MVP-B) and needs the owner's written
// approval (CLAUDE.md rule 1). Until then no code path in this package can reach a network.
export function createSandboxTransport(): Transport {
  return {
    kind: 'sandbox',
    send: async () => ({ kind: 'blocked', by: 'connect_off' }),
  };
}
