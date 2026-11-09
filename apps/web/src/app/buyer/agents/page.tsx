import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { listCaps, readAgentKeys } from '../../../composition/buyer';
import { agentsModel } from '../../../lib/buyer-agents-view';
import { DISPLAY_CURRENCIES } from '../../../lib/buyer-price';
import { CapCard } from '../../../ui/buyer/CapCard';
import { CapForm } from '../../../ui/buyer/CapForm';
import { EnvLabel } from '../../../ui/EnvLabel';
import { PageHeader, Section } from '../../../ui/publisher/kit';
import '../../../ui/buyer/buyer.css';

export const metadata: Metadata = { title: 'Agents' };

// INT-BUY / BUY.1: each agent key with its cap, a New cap form and End cap. The page is a server shell: it checks
// the sign-in, reads the buyer's keys and caps through the buyer composition module, and hands the client parts a
// one-time nonce for their Idempotency-Keys. An agent key never reaches this page: it has no session.
export default async function BuyerAgents() {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin?next=/buyer/agents');
  const a = await app();
  const [keys, caps] = await Promise.all([readAgentKeys(actor.buyer_id), listCaps(actor.buyer_id)]);
  const model = agentsModel({ keys, caps, now: a.security.clock.now() });
  const nonce = a.engine.newKey();
  return (
    <>
      <PageHeader
        title="Agents"
        aside={<EnvLabel environment={a.environment} />}
        lede="Give each agent key a spending cap. The agent can buy only inside it, and you can end it at any moment."
      />
      <Section title="Your agent keys" id="agents">
        {model.empty !== null ? <p data-testid="agents-empty">{model.empty}</p> : null}
        <ul className="cap-list" aria-label="Agent keys and their caps">
          {model.rows.map((r) => (
            <CapCard key={r.key_id} row={r} nonce={nonce} />
          ))}
        </ul>
      </Section>
      {model.newCapKeys.length > 0 ? (
        <Section title="New cap" id="new-cap">
          <CapForm keys={model.newCapKeys} currencies={DISPLAY_CURRENCIES} nonce={nonce} />
        </Section>
      ) : null}
    </>
  );
}
