// INT-UI0 / UI0.7: the composition module of the operator Agents and API tab.
// INT-CTL (CTL.7) adds its first read: the API exposure rows. They come from the api_exposure table, never from
// the journal, and only an operator gets them.
import type { Actor } from '@umsbx/contracts';
import { app } from '../server/access';
import type { ExposureRow } from '../server/access';

export async function readExposure(actor: Actor): Promise<ExposureRow[] | null> {
  return (await app()).engine.readApiExposure(actor);
}
