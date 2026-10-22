import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuditSink, createLogger, redact } from './index';
import type { SqlExecutor } from '@umsbx/contracts';

const KEYS = [
  'authorization',
  'access_token',
  'refresh_token',
  'client_secret',
  'client_id',
  'secret',
  'password',
  'passcode',
  'cookie',
  'set-cookie',
  'payer',
  'email_address',
  'email',
  'name',
  'given_name',
  'surname',
  'address',
  'phone',
  'payer_id',
  'paypal-transmission-sig',
];
const TOKEN = 'A21AAKtestcanarytokenvalue0123456789abcdefXYZ';
const BEARER = 'Bearer abcDEF123.ghi-jkl_mno~pqr+stu/vwx=';
const EMAIL = 'jane.doe+canary@example.com';

function canary(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of KEYS) o[k] = `CANARY-${k}`;
  return {
    ...o,
    order_ref: 'ord_keepme',
    amount_minor: 1250,
    nested: {
      deep: { ...o, upper: 'x', Authorization: 'CANARY-upper-auth', PAYER: { n: 'CANARY-obj' } },
    },
    list: [{ email: 'CANARY-list-email' }, 'plain', 42, null],
    free: `calling with ${BEARER} and ${TOKEN} by ${EMAIL} done`,
  };
}

describe('redact', () => {
  it('redact removes every key and pattern above from a canary object', () => {
    const out = JSON.stringify(redact(canary()));
    expect(out).not.toContain('CANARY');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('abcDEF123');
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain('example.com');
    expect(out).toContain('[redacted]');
  });
  it('keeps non-sensitive fields untouched', () => {
    const out = redact(canary()) as Record<string, unknown>;
    expect(out.order_ref).toBe('ord_keepme');
    expect(out.amount_minor).toBe(1250);
    expect((out.list as unknown[]).slice(1)).toEqual(['plain', 42, null]);
  });
  it('replaces a sensitive key whole, even when its value is an object', () => {
    const out = redact({ payer: { a: 1, b: 'x' }, Email: 'a@b.co' }) as Record<string, unknown>;
    expect(out.payer).toBe('[redacted]');
    expect(out.Email).toBe('[redacted]');
  });
  it('turns an email inside a string into sha256:<first 12 hex>', () => {
    const want = createHash('sha256').update(EMAIL.toLowerCase()).digest('hex').slice(0, 12);
    const out = redact({ note: `to ${EMAIL}.` }) as { note: string };
    expect(out.note).toBe(`to sha256:${want}.`);
  });
  it('redacts patterns in a bare string and in arrays', () => {
    expect(redact(`x ${BEARER} y`)).toBe('x [redacted] y');
    expect(redact([TOKEN])).toEqual(['[redacted]']);
  });
  it('does not mutate its input and survives cycles', () => {
    const input = canary();
    const before = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(before);
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() => redact(loop)).not.toThrow();
    expect(JSON.stringify(redact(loop))).toContain('[circular]');
  });
  it('passes primitives and handles Date and Uint8Array', () => {
    expect(redact(7)).toBe(7);
    expect(redact(null)).toBe(null);
    expect(redact(true)).toBe(true);
    expect(redact(new Date('2026-10-21T00:00:00Z'))).toBe('2026-10-21T00:00:00.000Z');
    expect(redact(new Uint8Array([1, 2]))).toBe('[binary]');
  });
});

describe('redact gaps (M5)', () => {
  const B64 = 'Y2xpZW50OnNlY3JldFZBTFVF';
  it('M5: Basic credentials in strings are redacted, plain words after "basic" are not', () => {
    expect(redact(`Authorization: Basic ${B64}==`)).not.toContain('Y2xpZW50');
    expect(redact(`header Basic ${B64}== end`)).toBe('header [redacted] end');
    expect(redact('authorization=Basic abcdefgh')).not.toContain('abcdefgh');
    expect(redact('a basic information page')).toBe('a basic information page');
    expect(redact('Basic')).toBe('Basic');
  });
  it('M5: key names are normalised (case, dash, underscore) and matched by substring', () => {
    const input: Record<string, unknown> = {
      clientSecret: 'CANARY1',
      PAYPAL_CLIENT_SECRET: 'CANARY2',
      approval_secret: 'CANARY3',
      token: 'CANARY4',
      id_token: 'CANARY5',
      'PayPal-Auth-Assertion': 'CANARY6',
      full_name: 'CANARY7',
      phone_number: 'CANARY8',
      accessToken: 'CANARY9',
      'X-Api-Token': 'CANARY10',
      LINK_SECRET: 'CANARY11',
      db_password: 'CANARY12',
      address_line_1: 'CANARY13',
      postal_code: 'CANARY14',
      shipping: { x: 'CANARY15' },
      Set_Cookie: 'CANARY16',
      order_ref: 'ord_keepme',
      amount_minor: 5,
      display_name: 'Shown',
    };
    const out = redact(input) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('CANARY');
    expect(out.order_ref).toBe('ord_keepme');
    expect(out.amount_minor).toBe(5);
    expect(out.display_name).toBe('Shown');
  });
  it('M5: JSON-encoded strings are parsed and redacted by key, at any depth', () => {
    const body = JSON.stringify({
      order_ref: 'ord_1',
      payer: { name: { given_name: 'JaneCANARY', surname: 'DoeCANARY' }, email_address: 'a@b.co' },
      purchase_units: [{ shipping: { address: { address_line_1: '1 MainCANARY St' } } }],
      note: JSON.stringify({ client_secret: 'INNERCANARY', keep: 'yes' }),
    });
    const out = redact({ request: body, list: [body] }) as { request: string; list: string[] };
    for (const text of [out.request, out.list[0]!]) {
      expect(text).not.toContain('CANARY');
      expect(text).not.toContain('a@b.co');
      expect(JSON.parse(text).order_ref).toBe('ord_1');
    }
    expect(redact(body)).not.toContain('CANARY');
    expect(JSON.parse(out.request).note).toContain('yes');
  });
  it('M5: invalid JSON, big strings and non-object JSON are left to the pattern pass', () => {
    expect(redact('{not json')).toBe('{not json');
    expect(redact('42')).toBe('42');
    expect(redact('"just a string"')).toBe('"just a string"');
    expect(redact('client_secret=SECRETCANARY&grant_type=client_credentials')).not.toContain(
      'SECRETCANARY',
    );
  });
});

describe('logger', () => {
  it('logger output for a seeded token and email contains neither', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), { env_label: 'dryrun' });
    log.log({
      msg: `got ${BEARER} for ${EMAIL}`,
      level: 'info',
      fields: { access_token: TOKEN, note: `mail ${EMAIL} tok ${TOKEN}`, order_ref: 'ord_1' },
    });
    log.child({ email: EMAIL, req_id: 'r1' }).log({ msg: 'child', level: 'warn', fields: {} });
    const all = lines.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('abcDEF123');
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain('example.com');
    expect(lines).toHaveLength(2);
  });
  it('emits one JSON line per event with level, msg, base, child and event fields', () => {
    const lines: string[] = [];
    const root = createLogger((l) => lines.push(l), { env_label: 'sandbox' });
    root
      .child({ req_id: 'r9' })
      .log({ msg: 'hello', level: 'error', fields: { op: 'create_order', duration_ms: 12 } });
    const line = lines[0]!;
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      msg: 'hello',
      env_label: 'sandbox',
      req_id: 'r9',
      op: 'create_order',
      duration_ms: 12,
    });
  });
  it('event fields cannot overwrite level or msg', () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l), {}).log({
      msg: 'real',
      level: 'info',
      fields: { level: 'fake', msg: 'fake' },
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('real');
  });
  it('adds ts from an injected clock when given one, never from real time', () => {
    const lines: string[] = [];
    const clock = { now: () => new Date('2026-10-21T10:00:00.000Z') };
    createLogger((l) => lines.push(l), {}, clock).log({ msg: 'm', level: 'debug', fields: {} });
    expect(JSON.parse(lines[0]!).ts).toBe('2026-10-21T10:00:00.000Z');
  });
});

describe('audit sink', () => {
  function fakeTx() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx: SqlExecutor = {
      query: async (sql, params) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
      exec: async () => undefined,
    };
    return { tx, calls };
  }
  const ids = { next: (p: string) => `${p}_FIXED`, nonce: () => 'n' };
  const clock = { now: () => new Date('2026-10-21T10:00:00.000Z') };

  it('inserts one audit_log row using the injected ids and clock, inside the given tx', async () => {
    const { tx, calls } = fakeTx();
    await createAuditSink(ids as never, clock).record(tx, {
      actor: { kind: 'operator', operator_id: 'op_1', mfa: true },
      action: 'kill_switch.set',
      target: 'sw_1',
      reason: 'drill',
      detail: { to: false },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/^\s*INSERT INTO audit_log/i);
    const p = calls[0]!.params;
    expect(p).toContain('aud_FIXED');
    expect(p).toContain('2026-10-21T10:00:00.000Z');
    expect(p).toContain('operator');
    expect(p).toContain('op_1');
    expect(p).toContain('kill_switch.set');
  });
  it('redacts the detail before it is stored', async () => {
    const { tx, calls } = fakeTx();
    await createAuditSink(ids as never, clock).record(tx, {
      actor: { kind: 'system' },
      action: 'x',
      target: null,
      reason: null,
      detail: { access_token: TOKEN, note: EMAIL },
    });
    const flat = JSON.stringify(calls[0]!.params);
    expect(flat).not.toContain(TOKEN);
    expect(flat).not.toContain(EMAIL);
  });
});
