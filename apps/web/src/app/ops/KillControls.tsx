'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  OPS_CONNECT_FLAG_OFF,
  OPS_START_ALREADY_ON,
  OPS_START_NEEDS_CODE,
  OPS_START_NO_APPROVAL,
  killControlsView,
  startDoneText,
} from '../../lib/ops-copy';
import { StartButton } from './StartButton';
import type { StartResult } from './StartButton';
import { StopButton } from './StopButton';

// The Start and Stop controls of the Kill switch block (WEB-OPS-START). Stop always renders (it is
// idempotent and needs no code); Start is the form, or one sentence that says why it does not apply.
// The switch state comes from the stored switch (a prop from the server page). After a start or a stop
// the page shows the new state at once and refreshes; the local state is dropped as soon as the server
// state arrives, so it never goes stale.
export function KillControls({
  outboundOn,
  hasCode,
  activeScope,
  flagOff,
}: {
  outboundOn: boolean;
  hasCode: boolean;
  activeScope: string | null;
  /** Sandbox mode with UMS_PAYPAL_CONNECT off: shown in words, never changed from here. */
  flagOff: boolean;
}) {
  const router = useRouter();
  // What this page just did, until the server state catches up: true after a start, false after a stop.
  const [override, setOverride] = useState<boolean | null>(null);
  const [started, setStarted] = useState<StartResult | null>(null);
  // A new form after the other action, so a stale "done" or error text does not linger.
  const [startGen, setStartGen] = useState(0);
  const [stopGen, setStopGen] = useState(0);
  useEffect(() => {
    setOverride(null);
  }, [outboundOn]);
  const on = override ?? outboundOn;
  const showFlagLine = started === null ? flagOff : started.connect_flag === 'off';
  function onStarted(r: StartResult) {
    setStarted(r);
    setOverride(true);
    setStartGen((n) => n + 1);
    router.refresh();
  }
  function onStopped() {
    setStarted(null);
    setOverride(false);
    setStopGen((n) => n + 1);
    router.refresh();
  }
  const view = killControlsView({ outboundOn: on, hasCode, activeScope });
  return (
    <>
      <div aria-live="polite" data-testid="ops-start-result">
        {started === null || !on ? null : startDoneText(started.calls_left, showFlagLine)}
      </div>
      {view.start === 'form' && activeScope !== null ? (
        <div className="pk-panel oh-start" data-testid="ops-start-form">
          <StartButton key={stopGen} activeScope={activeScope} onStarted={onStarted} />
        </div>
      ) : (
        <div className="pk-panel oh-note" data-testid="ops-start-replaced">
          <p>
            {view.start === 'already_on'
              ? OPS_START_ALREADY_ON
              : view.start === 'needs_code'
                ? OPS_START_NEEDS_CODE
                : OPS_START_NO_APPROVAL}
          </p>
        </div>
      )}
      <div className="pk-panel oh-stop" data-testid="ops-stop-form">
        <StopButton key={startGen} onStopped={onStopped} />
      </div>
      {showFlagLine ? (
        <p className="pk-note" data-testid="ops-connect-flag">
          {OPS_CONNECT_FLAG_OFF}
        </p>
      ) : null}
    </>
  );
}
