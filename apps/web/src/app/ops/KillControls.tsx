'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  OPS_CONNECT_FLAG_OFF,
  OPS_START_ALREADY_ON,
  OPS_START_NEEDS_CODE,
  OPS_START_NO_APPROVAL,
  OPS_STOP_ALREADY_OFF,
  killControlsView,
  startDoneText,
} from '../../lib/ops-copy';
import { StartButton } from './StartButton';
import type { StartResult } from './StartButton';
import { StopButton } from './StopButton';

// The Start and Stop controls of the Kill switch block (WEB-OPS-START). Both always render; the one that
// does not apply is replaced by one sentence that says why. The switch state comes from the stored
// switch (a prop from the server page); after a start the page shows it as On at once and refreshes.
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
  const [started, setStarted] = useState<StartResult | null>(null);
  const on = outboundOn || started !== null;
  const showFlagLine = started === null ? flagOff : started.connect_flag === 'off';
  function onStarted(r: StartResult) {
    setStarted(r);
    router.refresh();
  }
  const view = killControlsView({ outboundOn: on, hasCode, activeScope });
  return (
    <>
      {view.start === 'form' && activeScope !== null ? (
        <div className="pk-panel oh-start" data-testid="ops-start-form">
          <StartButton activeScope={activeScope} onStarted={onStarted} />
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
          <div aria-live="polite" data-testid="ops-start-result">
            {started === null ? null : startDoneText(started.calls_left)}
          </div>
        </div>
      )}
      {view.stop === 'form' ? (
        <div className="pk-panel oh-stop" data-testid="ops-stop-form">
          <StopButton />
        </div>
      ) : (
        <div className="pk-panel oh-note" data-testid="ops-stop-replaced">
          <p>{OPS_STOP_ALREADY_OFF}</p>
        </div>
      )}
      {showFlagLine ? (
        <p className="pk-note" data-testid="ops-connect-flag">
          {OPS_CONNECT_FLAG_OFF}
        </p>
      ) : null}
    </>
  );
}
