import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { readOpsControls } from '../../../composition/ops-controls';
import { EnvLabel } from '../../../ui/EnvLabel';
import { gateLines } from '../../../lib/gate-lines';
import { Chip, PageHeader, Section } from '../../../ui/publisher/kit';
import {
  OPS_HOME_HEADING_SWITCHES,
  OPS_HOME_SWITCHES_LEDE,
  switchView,
} from '../../../lib/ops-home-copy';
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
  return (
    <>
      <PageHeader
        title="Controls"
        aside={<EnvLabel environment={snap.environment} />}
        lede="The safety switches and the outbound approval gate. Read only here: the stop button is on Home."
      />
      <SectionNav label="Sections of this page" items={OPS_CONTROLS_SECTIONS} />

      <Section title={OPS_HOME_HEADING_SWITCHES} id="ops-switches">
        <p className="oh-lede">{OPS_HOME_SWITCHES_LEDE}</p>
        <ul className="oh-grid" aria-label="Safety switches">
          {Object.entries(snap.switches).map(([name, on]) => {
            const v = switchView(name, on, flagOff);
            return (
              <li key={name}>
                <div className="pk-panel oh-switch" data-testid={`ops-switch-${name}`}>
                  <p className="oh-switch-name">{v.label}</p>
                  <p className="oh-code">{v.name}</p>
                  <Chip tone={v.chip.tone}>{v.chip.text}</Chip>
                  {v.hint ? <p className="oh-hint">{v.hint}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
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
    </>
  );
}
