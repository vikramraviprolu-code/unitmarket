import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { OpenCase } from './OpenCase';
import { helpView } from '../../../lib/help-view';

export const metadata: Metadata = { title: 'Help' };

const TOPICS: Record<string, { title: string; body: string[] }> = {
  payment: {
    title: 'Help with a payment',
    body: [
      'You are only charged after you approve at the payment step, and we confirm the payment by reading it back before we unlock anything.',
      'If something looks stuck, open the order page: it updates by itself and says what is happening.',
    ],
  },
  frozen: {
    title: 'Your order is on hold',
    body: [
      'We found a difference between what you approved and what the payment shows. We stopped to protect you.',
      'You will not be charged twice. If this happens, we open a case and will write to you with the outcome.',
    ],
  },
  delivery: {
    title: 'The content did not open',
    body: [
      'If delivery failed on our side, your access time is paused and restored. You do not lose time.',
      'Ask us to look at it and we will check what happened.',
    ],
  },
  'not-charged': {
    title: 'Not charged',
    body: ['If the content was not ready, we did not take payment. The order says "Not charged".'],
  },
};

export default async function Help({
  params,
  searchParams,
}: {
  params: Promise<{ case: string }>;
  searchParams: Promise<{ item?: string }>;
}) {
  const { case: slug } = await params;
  const { item } = await searchParams;
  const topic = TOPICS[slug];
  if (topic === undefined) notFound();
  // GATEFIX2: a case is opened from an item. With no item the page gives guidance and a way to one.
  const view = helpView(slug, item);
  return (
    <>
      <h1>{topic.title}</h1>
      {topic.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {view.canOpenCase ? (
        <OpenCase note={`help:${slug}`} {...(item !== undefined ? { entitlementId: item } : {})} />
      ) : (
        <>
          <p data-testid="help-no-item">{view.note}</p>
          {view.link ? (
            <p>
              <Link className="btn" href={view.link.href}>
                {view.link.text}
              </Link>
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
