import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../../server/access';
import { currentActor, currentSessionId } from '../../../../server/session';
import { WindowMeter } from '../../../../ui/WindowMeter';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { OpenButton } from '../../OpenButton';
import { optionLabel } from '../../../../lib/format';
import {
  READER_DOWNLOAD_ANSWER,
  READER_ENDED,
  READER_HEADING_BACK,
  READER_NOT_READY,
  READER_STORE_DOWN,
} from '../../../../lib/reader-copy';

export const metadata: Metadata = { title: 'Read' };
// A read writes delivery evidence; it must never be cached or prerendered.
export const dynamic = 'force-dynamic';

const REFUSAL_TEXT = {
  window_ended: READER_ENDED,
  expired: READER_ENDED,
  not_available: READER_NOT_READY,
  store_unavailable: READER_STORE_DOWN,
} as const;

export default async function Reader({ params }: { params: Promise<{ entitlement: string }> }) {
  const { entitlement } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer')
    redirect(`/signin?next=${encodeURIComponent(`/library/${entitlement}/read`)}`);
  const session_id = await currentSessionId(actor);
  const view = await (
    await app()
  ).engine.readerView({
    entitlement_id: entitlement,
    actor,
    ...(session_id !== undefined ? { session_id } : {}),
  });
  const back = (
    <p>
      <Link className="btn" href={`/library/${encodeURIComponent(entitlement)}`}>
        {READER_HEADING_BACK}
      </Link>
    </p>
  );
  if (!view.ok) {
    if (view.code === 'not_found') notFound();
    return (
      <>
        <h1>Read</h1>
        <p role="alert" data-testid="reader-refusal">
          {REFUSAL_TEXT[view.code]}
        </p>
        {back}
      </>
    );
  }
  return (
    <>
      <p className="muted">{view.publisher}</p>
      <h1>{view.title}</h1>
      <p>
        {optionLabel(view.option)} <EnvLabel environment={view.environment} />
      </p>
      <WindowMeter
        state={view.window.state}
        daysLeft={view.window.days_left}
        endsAt={view.window.ends_at}
        option={view.option}
      />
      {view.kind === 'text' ? (
        <article data-testid="reader-text">
          {view.paragraphs.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
        </article>
      ) : (
        <>
          <p data-testid="reader-download">{READER_DOWNLOAD_ANSWER}</p>
          <div className="actions">
            <OpenButton entitlementId={entitlement} mode="download" />
          </div>
        </>
      )}
      {back}
    </>
  );
}
