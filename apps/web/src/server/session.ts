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

/**
 * The id of this request's session, for binding delivery links to it. Null outside a request (a
 * unit test calling a handler directly) or when the cookie is not a live session of this actor.
 */
export async function currentSessionId(actor: Actor): Promise<string | undefined> {
  try {
    const a = await app();
    const header = (await cookies()).toString();
    return (await a.engine.sessionIdOf(header === '' ? null : header, actor)) ?? undefined;
  } catch {
    return undefined;
  }
}
