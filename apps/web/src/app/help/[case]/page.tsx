import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OpenCase } from './OpenCase';

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
      'You will not be charged twice. We opened a case and will write to you with the outcome.',
    ],
  },
  delivery: {
    title: 'The content did not open',
    body: [
      'If delivery failed on our side, your 5 days are paused and restored. You do not lose time.',
      'Ask us to look at it and we will check what happened.',
    ],
  },
  'not-charged': {
    title: 'Not charged',
    body: ['If the content was not ready, we did not take payment. The order says "Not charged".'],
  },
};

export default async function Help({ params }: { params: Promise<{ case: string }> }) {
  const { case: slug } = await params;
  const topic = TOPICS[slug];
  if (topic === undefined) notFound();
  return (
    <>
      <h1>{topic.title}</h1>
      {topic.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
      <OpenCase note={`help:${slug}`} />
    </>
  );
}
