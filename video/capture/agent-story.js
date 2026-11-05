// Runs the MVP1 agent cap story against the local dry-run app and saves a redacted transcript.
// Uses only public test values: the e2e fixture passcode and the RFC 6238 test key for the
// operator "vikram", both from apps/web/playwright.config.ts. Run against the offline app only.
const crypto = require('crypto');
const fs = require('fs');
const H = 'http://localhost:3200'; // the offline dry-run app, never a PayPal host
const O = { Origin: H, 'Content-Type': 'application/json' };
const totp = (b32) => {
  const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32) bits += al.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', key).update(ctr).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
async function call(path, { body, headers = {}, method } = {}) {
  const r = await fetch(H + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...O, ...headers },
    body: body && JSON.stringify(body),
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { r, status: r.status, j };
}
const log = [];
const red = (o) =>
  JSON.parse(JSON.stringify(o, (k, v) => (/token|secret|csrf/i.test(k) ? '<hidden>' : v)));
const step = (title, cmd, out) => {
  log.push({ title, cmd, out: red(out) });
  console.log('#', title, '\n$', cmd, '\n', JSON.stringify(red(out)));
};
(async () => {
  const s = await call('/api/session', {
    body: { persona: 'buyer-b', passcode: 'e2e passcode one' },
  });
  const BC = cookieOf(s.r),
    BCSRF = s.j.csrf_token;
  const sess = { Cookie: BC, 'X-CSRF-Token': BCSRF };
  const n = Date.now().toString(36);
  const ak = await call('/api/v1/api-keys', {
    body: { key_kind: 'agent', scopes: ['catalogue:read', 'agent:buy'] },
    headers: { ...sess, 'Idempotency-Key': 'vid-agent-' + n },
  });
  step(
    'Buyer issues an agent key',
    'POST /api/v1/api-keys  {key_kind: "agent", scopes: [catalogue:read, agent:buy]}',
    { status: ak.status, id: ak.j.id, key_kind: ak.j.key_kind, scopes: ak.j.scopes, token: 'x' },
  );
  const ck = await call('/api/v1/api-keys', {
    body: { key_kind: 'api_client', scopes: ['mandates:write', 'events:read', 'orders:read'] },
    headers: { ...sess, 'Idempotency-Key': 'vid-client-' + n },
  });
  const AG = { Authorization: 'Bearer ' + ak.j.token },
    CL = { Authorization: 'Bearer ' + ck.j.token };
  const exp = new Date(Date.now() + 864e5).toISOString();
  const m = await call('/api/v1/mandates', {
    body: {
      agent_key_id: ak.j.id,
      currency: 'USD',
      max_total_minor: 500,
      max_count: 3,
      expires_at: exp,
      terms_accepted: true,
    },
    headers: { ...CL, 'Idempotency-Key': 'vid-mandate-' + n },
  });
  step(
    'Buyer sets a one-time cap: $5.00 and 3 purchases',
    'POST /api/v1/mandates  {max_total_minor: 500, max_count: 3}',
    {
      status: m.status,
      ...Object.fromEntries(
        [
          'id',
          'currency',
          'max_total_minor',
          'max_count',
          'remaining_total_minor',
          'remaining_count',
        ].map((k) => [k, m.j[k]]),
      ),
    },
  );
  const mcp = (name, args, id) =>
    call('/api/v1/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      headers: { ...AG, 'Idempotency-Key': id },
    });
  const buy = (offer, k, extra = {}) =>
    mcp('buy_unit', { publisher: 'harbour-ledger', offer, idempotency_key: k, ...extra }, k);
  let b0 = await buy('tide-tables', 'vid-b0-' + n);
  step(
    'Agent tries to buy before an operator allows agent buying',
    'mcp buy_unit  tide-tables',
    b0.j.result.structuredContent,
  );
  const o = await call('/api/session', {
    body: {
      persona: 'operator',
      passcode: 'e2e passcode one',
      operator: 'vikram',
      code: totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
    },
  });
  const on = await call('/api/ops/agent-buy', {
    body: { on: true, reason: 'video demo' },
    headers: { Cookie: cookieOf(o.r), 'X-CSRF-Token': o.j.csrf_token },
  });
  step(
    'Operator with a second factor turns agent buying on',
    'POST /api/ops/agent-buy  {on: true}   (operator signed in with authenticator code)',
    { mfa: o.j.mfa, ...on.j },
  );
  await new Promise((r) => setTimeout(r, 6500));
  const tl = await call('/api/v1/mcp', {
    body: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    headers: { ...AG, 'Idempotency-Key': 'vid-list-' + n },
  });
  step(
    'Agent lists its tools over MCP',
    'mcp tools/list',
    tl.j.result.tools.map((t) => t.name),
  );
  const bud = await mcp('check_budget', {}, 'vid-bud-' + n);
  const bs = bud.j.result.structuredContent;
  step('Agent reads its budget', 'mcp check_budget', {
    status: bs.status,
    currency: bs.currency,
    remaining_total_minor: bs.remaining_total_minor,
    remaining_count: bs.remaining_count,
  });
  const pick = (sc) =>
    sc.status === 'bought'
      ? {
          status: sc.status,
          title: sc.items?.[0]?.title,
          environment: sc.environment,
          remaining_total_minor: sc.remaining_total_minor,
          remaining_count: sc.remaining_count,
        }
      : sc;
  for (const [i, off, ex] of [
    [1, 'tide-tables'],
    [2, 'ferry-timetables'],
    [3, 'harbour-fees', { option: 'online_read' }],
  ]) {
    const r = await buy(off, `vid-b${i}-` + n, ex);
    step(`Agent buys unit ${i}`, `mcp buy_unit  ${off}`, pick(r.j.result.structuredContent));
  }
  const b4 = await buy('knot-notebook', 'vid-b4-' + n);
  step('The cap says stop', 'mcp buy_unit  knot-notebook', {
    ...b4.j.result.structuredContent,
    isError: b4.j.result.isError,
  });
  const off = await call('/api/ops/agent-buy', {
    body: { on: false, reason: 'video demo done' },
    headers: { Cookie: cookieOf(o.r), 'X-CSRF-Token': o.j.csrf_token },
  });
  fs.writeFileSync(__dirname + '/../assets/agent-story.json', JSON.stringify(log, null, 2));
  console.log('switch back off', off.j);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
