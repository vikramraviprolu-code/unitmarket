// INT-TR0 / TR0.2: the context store of the transaction journal. One context per request, job pass, webhook,
// CLI run or seed block, carried through async calls by one process-wide AsyncLocalStorage (trace-store.ts) and never mixed between them.
// withTraceDb (packages/db) reads it and puts it on every write. Ids and enums only: no name, no raw IP
// address and no User-Agent ever enters a context (the raw header is reduced to a family here).
import type { TraceContext, UaFamily } from '@umsbx/contracts';
import { traceStore } from './trace-store';

/** Runs `fn` with `ctx` as the current context. The stored context is a copy. */
export function withTraceContext<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return traceStore().run({ ...ctx }, fn);
}

export function currentTraceContext(): TraceContext | undefined {
  return traceStore().getStore();
}

/**
 * Opens a child of the current context for `fn`: the patch on top of the parent, with an id derived from the
 * parent's (`<parent>:<tool or job or channel>`). With no context open it runs `fn` unchanged.
 */
export function extendTraceContext<T>(
  patch: Partial<Omit<TraceContext, 'id'>>,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = traceStore().getStore();
  if (parent === undefined) return fn();
  const suffix = patch.tool ?? patch.job ?? patch.channel ?? 'child';
  return traceStore().run({ ...parent, ...patch, id: `${parent.id}:${suffix}` }, fn);
}

/**
 * Records the mandate an agent acts under, once it is known (the budget read finds it), on the context that is
 * open now. Writes made after this call carry it. Without an open context it does nothing.
 */
export function bindTraceMandate(mandate_id: string): void {
  const cur = traceStore().getStore();
  if (cur !== undefined) cur.mandate_id = mandate_id;
}

const CURL = /\b(curl|wget)\b/i;
const SDK =
  /(python-requests|python-urllib|aiohttp|httpx|node-fetch|undici|axios|okhttp|go-http-client|libwww|java\/|anthropic|openai|[-_ ]sdk)/i;
const BROWSER = /(mozilla|chrome|safari|firefox|edg\/|opera)/i;

/** Reduces a User-Agent header to one of four families. Never returns any part of the header. */
export function uaFamilyOf(ua: string | null | undefined): UaFamily {
  if (ua === null || ua === undefined || ua === '') return 'other';
  if (CURL.test(ua)) return 'curl';
  if (SDK.test(ua)) return 'sdk';
  if (BROWSER.test(ua)) return 'browser';
  return 'other';
}

/** The context of an operator CLI run: channel cli, actor operator `cli:<os user hash>`, never the user name. */
export function cliTraceContext(o: {
  id: string;
  at: string;
  user_hash: string;
  job?: string;
}): TraceContext {
  return {
    id: o.id,
    at: o.at,
    channel: 'cli',
    actor_kind: 'operator',
    actor_id: `cli:${o.user_hash}`,
    on_behalf_of: null,
    mandate_id: null,
    mfa: false,
    req_id: null,
    ip_hash: null,
    ua_family: null,
    api_key_id: null,
    job: o.job ?? null,
    tool: null,
  };
}
