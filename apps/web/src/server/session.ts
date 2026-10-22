import 'server-only';
import { cookies } from 'next/headers';
import type { Actor } from '@umsbx/contracts';
import { app } from './access';

/** The signed-in actor for this request, or null. Pages call this; routes use withRoute. */
export async function currentActor(): Promise<Actor | null> {
  const a = await app();
  const header = (await cookies()).toString();
  return a.engine.actorFromCookie(header === '' ? null : header);
}
