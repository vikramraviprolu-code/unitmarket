import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { readKeyViews } from '../../../composition/buyer';
import { keysModel } from '../../../lib/buyer-keys-view';
import { KeyList } from '../../../ui/buyer/KeyList';
import { PageHeader, Section } from '../../../ui/publisher/kit';
import '../../../ui/buyer/buyer.css';

export const metadata: Metadata = { title: 'API keys' };

// INT-BUY / BUY.8: list, make and revoke API keys over the owner routes /api/v1/api-keys. The server renders the
// list from the view (no secret). The one-time secret exists only in the client part, in memory, for one screen.
export default async function BuyerKeys() {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin?next=/buyer/keys');
  const a = await app();
  const model = keysModel(await readKeyViews(actor.buyer_id), a.security.clock.now());
  return (
    <>
      <PageHeader
        title="API keys"
        lede="Keys let a program or an AI agent act for you. Give an agent a cap on the Agents page before it can buy."
      />
      <Section title="Your keys" id="keys">
        <KeyList model={model} nonce={a.engine.newKey()} />
      </Section>
    </>
  );
}
