import { createHash } from 'node:crypto';
import { CERT_HOST, LIVE_HOST, LIVE_WWW, SANDBOX_HOST } from './test-helpers';

// Offline hostile corpus for the fixture recorder (B-L3). Every canary is derived at runtime from a
// label, so no source file or fixture carries a secret-looking literal and the repository scanners
// stay quiet. Nothing here is a real credential or a real person.

const b64 = (label: string, len: number): string =>
  createHash('sha512')
    .update(`recorder-canary:${label}`)
    .digest('base64')
    .replace(/[+/=]/g, 'x')
    .slice(0, len);

export interface Canaries {
  email: string;
  email2: string;
  uniEmail: string;
  relToken: string;
  displayName: string;
  phoneText: string;
  noteText: string;
  token: string;
  jwt: string;
  clientId: string;
  clientSecret: string;
  payerId: string;
  given: string;
  surname: string;
  street: string;
  nonce: string;
  sig: string;
  plain: string;
  basic: string;
  all: string[];
}

export function makeCanaries(): Canaries {
  const mailHost = ['canary-mail', 'example', 'org'].join('.');
  const email = `${b64('email', 9).toLowerCase()}.buyer@${mailHost}`;
  const email2 = `${b64('email2', 8).toLowerCase()}+tag@${mailHost}`;
  // FIX-BPREP L2: survivors found in review. A Unicode domain, a relative link with a query token,
  // a business display name, a phone number in prose and a free-text note naming a person.
  const uniEmail = `${b64('uemail', 7).toLowerCase()}@ex\u00e4mple.${b64('udom', 4).toLowerCase()}`;
  const relToken = `rt${b64('reltoken', 18)}`;
  const displayName = `Shop${b64('display', 6).toLowerCase()} Ltd`;
  const phoneText = `+49 151 ${String(Math.abs(b64('phone', 8).length * 1234567)).padStart(7, '1')}`;
  const noteText = `Dear ${b64('note', 6).toLowerCase()}zorg`;
  const jwt = [
    `eyJ${b64('jwt-h', 20)}`,
    `eyJ${b64('jwt-p', 30)}`,
    b64('jwt-s', 27).replace(/x/g, '_'),
  ].join('.');
  const clientId = `A${b64('client-id', 79)}`;
  const clientSecret = `E${b64('client-secret', 79)}`;
  const c = {
    email,
    email2,
    uniEmail,
    relToken,
    displayName,
    phoneText,
    noteText,
    token: `A21AA${b64('token', 70)}`,
    jwt,
    clientId,
    clientSecret,
    payerId: `PX${b64('payer', 11).toUpperCase()}`,
    given: `Gwen${b64('given', 6).toLowerCase()}`,
    surname: `Surn${b64('surname', 6).toLowerCase()}`,
    street: `${b64('street', 5)} Strasse 12`,
    nonce: `2026-10-22T10:00:00Z${b64('nonce', 36)}`,
    sig: b64('sig', 44),
    plain: `plain${b64('plain', 12)}`,
    basic: Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
  };
  return { ...c, all: Object.values(c) };
}

export const host = {
  live: LIVE_HOST,
  liveWww: LIVE_WWW,
  sandboxApi: SANDBOX_HOST,
  sandboxWww: ['www', 'sandbox', 'paypal', 'com'].join('.'),
  sandboxCert: CERT_HOST,
  evil: ['collector', 'attacker', 'example'].join('.'),
};

type Obj = Record<string, unknown>;

/** A well-formed raw exchange as the owner's spike writes it. */
export function exchange(over: Obj = {}): Obj {
  return {
    scenario: 'spike_happy',
    operation: 'get_order',
    request: {
      method: 'GET',
      path: '/v2/checkout/orders/5O190127TN364715T',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer placeholder-token-value',
      },
      body: null,
    },
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'PayPal-Debug-Id': 'a1b2c3d4e5f67' },
      body: { id: '5O190127TN364715T', status: 'CREATED' },
    },
    ...over,
  };
}

/** One exchange stuffed with every hostile trick; none of the canaries may survive. */
export function hostileExchange(c: Canaries): Obj {
  const nestedJson = JSON.stringify({
    outer: { inner: [{ note: `please contact ${c.email} today` }] },
    deeper: JSON.stringify({ again: c.email2 }),
  });
  return exchange({
    scenario: 'hostile',
    operation: 'get_order',
    request: {
      method: 'GET',
      path: '/v2/checkout/orders/5O190127TN364715T?access_token=' + c.token,
      headers: {
        AUTHORIZATION: `Bearer ${c.token}`,
        'Authorization ': `Basic ${c.basic}`,
        'authorization\t': c.token,
        AuThOrIzAtIoN: c.jwt,
        'X-PayPal-Auth-Assertion': c.jwt,
        'PAYPAL-AUTH-ASSERTION': c.jwt,
        Cookie: `session=${c.token}`,
        'SET-COOKIE': `sid=${c.token}`,
        'Proxy-Authorization': `Basic ${c.basic}`,
        'x-api-key': c.clientSecret,
        'X-Forwarded-Email': c.email,
        'Content-Type': ['application/json', 'application/xml; charset=utf-8'],
        'PayPal-Request-Id': '4f9d1c6e-8a52-4d0b-9a77-6d1b2f0c9e11',
      },
      body: { client_id: c.clientId, Client_Secret: c.clientSecret, clientSecret: c.clientSecret },
    },
    response: {
      status: 200,
      headers: { 'PayPal-Debug-Id': 'a1b2c3d4e5f67', 'Content-Type': 'application/json' },
      body: {
        id: '5O190127TN364715T',
        status: 'APPROVED',
        debug_id: 'a1b2c3d4e5f67',
        ACCESS_TOKEN: c.token,
        ' payer_id ': c.payerId,
        Email_Address: c.email,
        NONCE: c.nonce,
        nonce: c.nonce,
        app_id: c.clientId,
        payer: {
          name: { given_name: c.given, surname: c.surname },
          email_address: c.email,
          payer_id: c.payerId,
          address: { address_line_1: c.street, admin_area_2: 'Berlin', country_code: 'DE' },
          phone: { phone_number: { national_number: '4915112345678' } },
        },
        shipping: {
          name: { full_name: `${c.given} ${c.surname}` },
          address: { address_line_1: c.street },
        },
        payment_source: { paypal: { name: { given_name: c.given }, account_id: c.payerId } },
        nested_json_string: nestedJson,
        description: `ref ${c.jwt} end`,
        blob: c.token,
        urlenc: `mail%3D${encodeURIComponent(c.email)}`,
        entity: c.email.replace('@', '&#64;'),
        hexentity: c.email2.replace('@', '&#x40;'),
        upper: c.email.toUpperCase(),
        spaced: c.email.replace('@', ' [at] '),
        message: `Authorization: Bearer ${c.token} and Basic ${c.basic}`,
        sig_field: c.sig,
        links: [
          {
            href: `https://${host.sandboxWww}/checkoutnow?token=5O190127TN364715T`,
            rel: 'approve',
          },
          { href: `https://${host.sandboxWww}/signin?token=${c.token}&email=${c.email}`, rel: 'x' },
          { href: '/v2/checkout/orders/5O190127TN364715T', rel: 'self' },
        ],
        cert_url: `https://${host.sandboxCert}/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270?sig=${c.sig}&k=${c.plain}`,
        arr: [[[{ deep: c.email }]]],
        payee: { display_name: c.displayName, merchant_id: 'YXZY75W2GKDQE', name: c.displayName },
        unicode_mail: `write to ${c.uniEmail} please`,
        relative_link: `/checkoutnow?token=${c.relToken}&PayerID=${c.payerId}`,
        bare_relative_link: `checkoutnow?token=${c.relToken}`,
        prose_phone: `call ${c.phoneText} after five`,
        note_to_payer: c.noteText,
      },
    },
  });
}

/** Inputs that must be refused as live or non-sandbox. */
export function liveInputs(): Record<string, Obj> {
  const wrap = (request: Obj, body: unknown = { ok: true }): Obj =>
    exchange({
      request: { method: 'GET', path: '/v2/checkout/orders/5O190127TN364715T', ...request },
      response: { status: 200, headers: {}, body },
    });
  return {
    live_url: wrap({ url: `https://${host.live}/v2/checkout/orders/5O190127TN364715T` }),
    live_url_upper: wrap({
      url: `HTTPS://${host.live.toUpperCase()}/v2/checkout/orders/5O190127TN364715T`,
    }),
    live_host_header: wrap({ headers: { HOST: host.live } }),
    live_origin_header: wrap({ headers: { Origin: `https://${host.liveWww}` } }),
    other_host_url: wrap({ url: `https://${host.evil}/v2/checkout/orders/5O190127TN364715T` }),
    sandbox_lookalike: wrap({
      url: `https://${host.sandboxApi}.${host.evil}/v2/checkout/orders/X1`,
    }),
    sandbox_prefix_trick: wrap({
      url: `https://${host.evil}/${host.sandboxApi}/v2/checkout/orders/X1`,
    }),
    userinfo_trick: wrap({ url: `https://${host.sandboxApi}@${host.evil}/v2/checkout/orders/X1` }),
    live_link_in_body: wrap(
      {},
      { links: [{ href: `https://${host.liveWww}/checkoutnow?token=X` }] },
    ),
    live_host_in_nested_json: wrap({}, { raw: JSON.stringify({ u: `https://${host.live}/v1/x` }) }),
    live_base_url_field: wrap({ base_url: `https://${host.live}` }),
  };
}
