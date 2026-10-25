// CO-Gb (gate review M1). Not a test file. A helper module that imports the network modules the way
// product code does, so the C-offline canary can show two things about the interception in
// c-offline.adversarial.test.ts: (1) a module loaded from a test's module graph sees the PATCHED
// node:net (default, named and namespace import alike), and (2) each way of opening a connection that
// replacing module exports alone misses is recorded and refused. Every target is loopback port 1 or
// the name `localhost` (answered from the hosts file), so even with no interception nothing leaves
// the machine: the connection is refused on this host.
//
// Lint bars network imports outside packages/transport (S2). This file is the one pinned exemption
// (NAMED_EXEMPTIONS, no-restricted-imports only); it makes no request of its own that is not a probe.
import dns from 'node:dns';
import dnsPromises, { lookup as lookupNamed } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net, { Socket, connect as connectNamed } from 'node:net';
import * as netNamespace from 'node:net';

const HOST = '127.0.0.1';
const PORT = 1;
const noop = (): void => undefined;

/** Anything a probe may hand back that must be closed so the test leaves nothing open. */
function release(thing: unknown): void {
  if (thing instanceof Promise) {
    thing.then(noop, noop);
    return;
  }
  if (typeof thing !== 'object' || thing === null) return;
  const t = thing as { on?: (e: string, f: () => void) => unknown; destroy?: () => void };
  t.on?.('error', noop);
  t.destroy?.();
}

/** Runs one probe: true when it threw (an interception refused it), false when it returned. */
function attempt(f: () => unknown): boolean {
  try {
    release(f());
    return false;
  } catch {
    return true;
  }
}

/** The views of node:net a product module could hold. */
export const netViews = {
  'default import': (): boolean => attempt(() => net.connect(PORT, HOST)),
  'named import': (): boolean => attempt(() => connectNamed(PORT, HOST)),
  'namespace import': (): boolean => attempt(() => netNamespace.connect(PORT, HOST)),
};

/** The five shapes replacing module exports misses, plus the https twin of the Agent one. */
export const bypassShapes = {
  'net.Socket.prototype.connect': (): boolean => attempt(() => new Socket().connect(PORT, HOST)),
  'dns.promises.lookup': (): boolean => attempt(() => dns.promises.lookup('localhost')),
  'node:dns/promises named lookup': (): boolean => attempt(() => lookupNamed('localhost')),
  'node:dns/promises default lookup': (): boolean => attempt(() => dnsPromises.lookup('localhost')),
  // a Resolver asks its name servers directly (c-ares), not the hosts file: point it at loopback port 1
  // first, so even an unguarded call is refused on this machine and no query leaves it
  'dns.Resolver resolve4': (): boolean =>
    attempt(() => {
      const r = new dns.Resolver();
      r.setServers([`${HOST}:${PORT}`]);
      return r.resolve4('localhost', noop);
    }),
  'dns.promises.Resolver resolve4': (): boolean =>
    attempt(() => {
      const r = new dnsPromises.Resolver();
      r.setServers([`${HOST}:${PORT}`]);
      return r.resolve4('localhost');
    }),
  'http2.connect': (): boolean => attempt(() => http2.connect(`http://${HOST}:${PORT}`)),
  'http.Agent createConnection': (): boolean =>
    attempt(() => new http.Agent().createConnection({ host: HOST, port: PORT })),
  'https.Agent createConnection': (): boolean =>
    attempt(() => new https.Agent().createConnection({ host: HOST, port: PORT })),
};

/** The unpatched functions, handed over by the interception for the channel proof. */
export interface RawNet {
  socketConnect: (this: Socket, ...a: unknown[]) => unknown;
  agentCreateConnection: (this: http.Agent, ...a: unknown[]) => unknown;
  http2Connect: (...a: unknown[]) => unknown;
}

/**
 * Opens three real client sockets with the UNPATCHED functions, all to the closed loopback port 1,
 * and closes them again. Used only to show that the `net.client.socket` channel sees a socket whatever
 * route made it. The refusal happens on this machine.
 */
export async function openRaw(raw: RawNet): Promise<void> {
  const made: unknown[] = [];
  // an error handler goes on each object the moment it exists: the refusal arrives within milliseconds
  const keep = <T>(thing: T): T => {
    (thing as { on?: (e: string, f: () => void) => unknown }).on?.('error', noop);
    made.push(thing);
    return thing;
  };
  const s = keep(new Socket());
  Reflect.apply(raw.socketConnect, s, [PORT, HOST]);
  keep(Reflect.apply(raw.agentCreateConnection, new http.Agent(), [{ host: HOST, port: PORT }]));
  keep(Reflect.apply(raw.http2Connect, http2, [`http://${HOST}:${PORT}`]));
  await new Promise((r) => setTimeout(r, 50)); // let the refusals arrive
  for (const m of made) release(m);
}

/** The shared module object itself (what `require('node:dns')` or `process.getBuiltinModule` hands out). */
export function viaSharedDns(shared: unknown): boolean {
  return attempt(() => (shared as typeof dns).lookup('localhost', noop));
}
