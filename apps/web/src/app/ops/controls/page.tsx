import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { mintKeys, readAppStatus, readOpsControls } from '../../../composition/ops-controls';
import { EnvLabel } from '../../../ui/EnvLabel';
import { gateLines } from '../../../lib/gate-lines';
import { Chip, PageHeader, Section } from '../../../ui/publisher/kit';
import { OPS_HOME_HEADING_SWITCHES, OPS_HOME_SWITCHES_LEDE } from '../../../lib/ops-home-copy';
import { GatewayPanel } from '../../../ui/ops/GatewayPanel';
import { ServicesPanel } from '../../../ui/ops/ServicesPanel';
import { SwitchList } from '../../../ui/ops/SwitchList';
import { gatewayView } from '../../../lib/gateway-view';
import { switchLines } from '../../../lib/switches-view';
import { KillControls } from '../KillControls';
import { SectionNav } from '../../../ui/SectionNav';
import { OPS_CONTROLS_SECTIONS } from '../../../lib/ops-copy';
import '../pk-opshome.css';

export const metadata: Metadata = { title: 'Controls' };

// INT-UI0: the safety switches and the outbound approval gate of the old /ops page, as they were. The kill
// switch and its start and stop buttons stay on Home.
export default async function OpsControls() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/controls');
  const read = await readOpsControls(actor);
  if (read === null) redirect('/signin?next=/ops/controls');
  const { snap, flagOff } = read;
  const appStatus = await readAppStatus();
  const lines = switchLines(snap.switches, flagOff);
  const keys = await mintKeys(lines.length);
  const gateway = gatewayView({ mode: snap.gate.mode, locks: snap.gate.outbound?.locks ?? null });
  return (
    <>
      <PageHeader
        title="Controls"
        aside={<EnvLabel environment={snap.environment} />}
        lede="The safety switches, the outbound approval gate, the gateway locks and the services. Turning a switch off needs no authenticator code; turning one on does."
      />
      <SectionNav label="Sections of this page" items={OPS_CONTROLS_SECTIONS} />

      <Section title={OPS_HOME_HEADING_SWITCHES} id="ops-switches">
        <p className="oh-lede">{OPS_HOME_SWITCHES_LEDE}</p>
        <SwitchList lines={lines} keys={keys} />
      </Section>

      <Section title="Outbound approval gate" id="ops-gate-section">
        <div className="pk-panel">
          <ul className="oh-list" data-testid="ops-gate">
            {gateLines(snap.gate).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      </Section>

      <Section title="Gateway locks" id="ops-gateway">
        <GatewayPanel view={gateway} />
        <KillControls
          outboundOn={snap.kill_switch.outbound_on}
          hasCode={actor.mfa === true}
          activeScope={snap.kill_switch.active_scope}
          flagOff={flagOff}
        />
      </Section>

      <Section title="Services" id="ops-services">
        <ServicesPanel app={appStatus} />
      </Section>
    </>
  );
}
