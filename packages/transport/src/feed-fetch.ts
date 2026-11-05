import dns from 'node:dns';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  FEED_DEADLINE_MS,
  FEED_MAX_BYTES,
  checkFeedHead,
  checkFeedUrl,
  checkResolved,
  endsInNumber,
  feedMediaType,
} from './feed-guard';
import type { FeedKind, FeedRefusal } from './feed-guard';

// FEED (E-02, nfr SOP 18, P19), adapted for the web import (POB-I1, D-089). The one real fetcher for a
// publisher's own web address, and the only network code the import has. It is not a general client: GET
// only, https on port 443 only, a host that the CALLER names for this one call (the publisher's verified
// domain, or the host whose proof is being checked), an address that is public. Nothing is configured: the
// feature has no allow list of its own and no deploy is needed for a new publisher.
//
// What it does, in order: check the allow list and the url (feed-guard); resolve the name ONCE for this call;
// refuse if ANY answer is non-public (so a domain that was fine at the proof and now points inside is
// refused on the next call); connect to the pinned address (the host name is only the TLS name and the Host
// header, so there is no second lookup to rebind); check the connected peer is that address; never follow a
// redirect; refuse a wrong type, a compressed body or more than 2 MB; give up after 5 s for the whole
// exchange. A refusal is a fixed kind. No url, address, header or peer text is kept in it.

/** What one call may do: reach only these hosts, and receive text or a picture. */
export interface FetchOptions {
  /** The hosts this call may reach (exact lower case names). Empty: refused as feed_off. */
  allow: readonly string[];
  /** Default text. A picture is jpeg, png or webp only, and its bytes are returned undecoded. */
  kind?: FeedKind;
}

export type FeedFetchResult =
  | { ok: true; body: string; bytes: Uint8Array; content_type: string; host: string }
  | { ok: false; reason: FeedRefusal };

export interface FeedFetcher {
  fetch(url: string, o: FetchOptions): Promise<FeedFetchResult>;
}

export interface FeedFetcherDeps {
  /** One name lookup per fetch: every address the name has. A fake in tests. */
  resolve: (host: string) => Promise<readonly string[]>;
  /** https.request captured at load (a fake in tests). */
  request: typeof https.request;
  agent: https.Agent;
}

const fail = (reason: FeedRefusal): FeedFetchResult => ({ ok: false, reason });
const peerOf = (a: string): string => a.toLowerCase().replace(/^::ffff:/, '');
const ACCEPT: Record<FeedKind, string> = {
  text: 'text/html, application/json, application/feed+json, application/ld+json, application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, text/plain;q=0.8',
  image: 'image/jpeg, image/png, image/webp',
};

/** Internal: builds the fetcher from its dependencies. Used by createFeedFetcher and by its tests. */
export function makeFeedFetcher(deps: FeedFetcherDeps): FeedFetcher {
  function fetchFeed(url: string, o: FetchOptions): Promise<FeedFetchResult> {
    const allow: unknown = o?.allow;
    if (!Array.isArray(allow) || allow.length === 0) return Promise.resolve(fail('feed_off'));
    // Every entry must be a usable lower case name: one bad entry refuses the call before any lookup.
    if (!allow.every(isFeedHostName)) return Promise.resolve(fail('host_not_allowed'));
    const kind: FeedKind = o.kind === 'image' ? 'image' : 'text';
    const checked = checkFeedUrl(url, allow);
    if (!checked.ok) return Promise.resolve(fail(checked.reason));
    const { host, path } = checked;
    return new Promise<FeedFetchResult>((resolve) => {
      let finished = false;
      let req: ClientRequest | undefined;
      let res: IncomingMessage | undefined;
      const settle = (r: FeedFetchResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          res?.destroy();
        } catch {
          /* already gone */
        }
        try {
          req?.destroy();
        } catch {
          /* already gone */
        }
        resolve(r);
      };
      // The one clock for the whole exchange, name lookup included.
      const timer = setTimeout(() => settle(fail('timeout')), FEED_DEADLINE_MS);

      void (async () => {
        let answers: readonly string[];
        try {
          answers = await deps.resolve(host);
        } catch {
          return settle(fail('dns_failed'));
        }
        if (finished) return;
        if (!Array.isArray(answers) || answers.length === 0) return settle(fail('dns_failed'));
        const pin = checkResolved(answers);
        if (!pin.ok) return settle(fail('private_address'));
        try {
          req = deps.request(
            {
              protocol: 'https:',
              host: pin.address,
              port: 443,
              path,
              method: 'GET',
              headers: {
                host,
                accept: ACCEPT[kind],
                'accept-encoding': 'identity',
                'user-agent': 'UnitMarket-Feed/1',
              },
              agent: deps.agent,
              servername: host,
              rejectUnauthorized: true,
              minVersion: 'TLSv1.2',
              insecureHTTPParser: false,
            },
            (response: IncomingMessage) => onResponse(response, pin.address),
          );
        } catch {
          return settle(fail('network'));
        }
        req.on('error', () => settle(fail('network')));
        req.end();
      })();

      function onResponse(response: IncomingMessage, pinned: string): void {
        res = response;
        response.on('error', () => settle(fail('network')));
        // Re-check: the peer we are talking to is the address we pinned, not something else.
        const remote = response.socket?.remoteAddress;
        if (typeof remote !== 'string' || peerOf(remote) !== peerOf(pinned))
          return settle(fail('pin_mismatch'));
        const refusal = checkFeedHead(response.statusCode ?? 0, response.headers, kind);
        if (refusal !== null) return settle(fail(refusal));
        const content_type = feedMediaType(response.headers['content-type'], kind) ?? '';
        const chunks: Buffer[] = [];
        let total = 0;
        let ended = false;
        response.on('data', (chunk: Buffer | string) => {
          if (finished) return;
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          total += b.byteLength;
          if (total > FEED_MAX_BYTES) return settle(fail('too_large'));
          chunks.push(b);
        });
        response.on('end', () => {
          ended = true;
          const bytes = new Uint8Array(Buffer.concat(chunks));
          if (kind === 'image') return settle({ ok: true, body: '', bytes, content_type, host });
          let body: string;
          try {
            body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            return settle(fail('bad_body'));
          }
          settle({ ok: true, body, bytes, content_type, host });
        });
        response.on('close', () => {
          if (!ended) settle(fail('network'));
        });
      }
    });
  }
  return { fetch: fetchFeed };
}

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A usable allow list entry: a lower case DNS name with at least two labels, not a number, not localhost. */
export function isFeedHostName(h: unknown): h is string {
  return (
    typeof h === 'string' &&
    HOSTNAME.test(h) &&
    !endsInNumber(h) &&
    h !== 'localhost' &&
    !h.endsWith('.localhost')
  );
}

// Captured when this module loads, like the other wires: a later replacement of the platform functions
// does not change what this fetcher calls.
const LOADED_REQUEST = https.request;
const LOADED_LOOKUP = dns.promises.lookup;

/**
 * The production fetcher. It takes no allow list: each call names the host it may reach. Composition builds
 * it once, outside tests, and passes it to the domain as a port.
 */
export function createFeedFetcher(): FeedFetcher {
  return makeFeedFetcher({
    resolve: async (host) =>
      (await LOADED_LOOKUP(host, { all: true, verbatim: true })).map((a) => a.address),
    request: LOADED_REQUEST,
    agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }),
  });
}
