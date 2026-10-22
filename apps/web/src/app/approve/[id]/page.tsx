import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { ApproveClient } from './ApproveClient';

export const metadata: Metadata = { title: 'Approve' };

export default async function Approve({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect(`/signin?next=${encodeURIComponent(`/approve/${id}`)}`);
  const a = await app();
  const view = await a.engine.approvalView({ approval_id: id, actor });
  if (view === null) notFound();
  return (
    <>
      <h1>Approve your purchase</h1>
      <p className="lede">
        Check the details. You pay nothing until you approve at the payment step.
      </p>
      <ApproveClient view={view} idemKey={a.engine.newKey()} />
    </>
  );
}
