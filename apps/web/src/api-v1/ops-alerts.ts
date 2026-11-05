// INT-AL AL.1, AL.6, AL.7: the operator reads of alerts, the needs-you list and cases. All GET, all behind the
// ops:read scope. The answers carry order refs, unit ids, amounts, states and ids: no buyer, no seller, no PayPal
// id, no actor id and no message text. The write side is the operator session routes under /api/ops.
import type { HttpResult } from '@umsbx/security';
import type { App } from '../../composition.server';
import { FORBIDDEN, NOT_FOUND, ownerOf, type Ctx } from './guard';

type Result<T> = Promise<HttpResult<T>>;

export async function alertList(
  a: App,
  ctx: Ctx,
  q: Parameters<App['engine']['opsReads']['alerts']>[0],
): Result<unknown> {
  if (ownerOf(ctx, 'operator') === null) return FORBIDDEN;
  return { status: 200, body: await a.engine.opsReads.alerts(q) };
}

export async function alertDetail(a: App, ctx: Ctx, id: string): Result<unknown> {
  if (ownerOf(ctx, 'operator') === null) return FORBIDDEN;
  const d = await a.engine.opsReads.alert(id);
  if (d === null) return NOT_FOUND('alert');
  // The journal knows who acted; the key reader is told the kind and the channel, never the id.
  const history = d.history.map((h) => ({
    kind: h.kind,
    reason_code: h.reason_code,
    at: h.at,
    actor_kind: h.actor_kind,
    channel: h.channel,
  }));
  return { status: 200, body: { ...d, history } };
}

export async function needsYouList(a: App, ctx: Ctx): Result<unknown> {
  if (ownerOf(ctx, 'operator') === null) return FORBIDDEN;
  return { status: 200, body: { items: await a.engine.opsReads.needsYou() } };
}

export async function caseList(
  a: App,
  ctx: Ctx,
  q: Parameters<App['engine']['opsReads']['cases']>[0],
): Result<unknown> {
  if (ownerOf(ctx, 'operator') === null) return FORBIDDEN;
  return { status: 200, body: await a.engine.opsReads.cases(q) };
}

export async function caseDetail(a: App, ctx: Ctx, id: string): Result<unknown> {
  if (ownerOf(ctx, 'operator') === null) return FORBIDDEN;
  const d = await a.engine.opsReads.case(id);
  return d === null ? NOT_FOUND('case') : { status: 200, body: d };
}
