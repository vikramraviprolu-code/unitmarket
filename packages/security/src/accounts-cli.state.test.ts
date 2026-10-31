// ID-ACCOUNTS: the operator reset (pnpm accounts:reset-password). Modelled on safety:approve: a person's
// terminal only, never in CI or an AI session, two prompts with echo off, the same password policy, the
// account's sessions ended, one audit row. The prompts are scripted here; nothing is printed with the password.
import { describe, expect, it } from 'vitest';
import { createAccount, verifyAccountLogin } from './accounts';
import { runResetPassword } from './accounts-cli';
import { createSession, resolveSession } from './session';
import { cookiePair, makeRig } from './test-support';
import type { TestRig } from './test-support';

const TTY = { isTTY: true, env: {} as Record<string, string | undefined> };
const NEW = 'seven quiet harbours';
let n = 0;

async function world(): Promise<{ r: TestRig; username: string; buyer_id: string }> {
  const r = await makeRig();
  n += 1;
  const username = `reset.${String(n)}`;
  const res = await createAccount(r.deps, {
    display_name: 'Reset Reader',
    username,
    country: 'GB',
    password: 'violet lamps hum softly',
    consent_version: 'terms-v1',
  });
  if (!res.ok) throw new Error('setup');
  return { r, username, buyer_id: res.buyer_id };
}
const scripted = (answers: string[]) => {
  const asked: string[] = [];
  const out: string[] = [];
  return {
    asked,
    out,
    askSecret: async (prompt: string) => {
      asked.push(prompt);
      return answers.shift() ?? '';
    },
    write: (l: string) => void out.push(l),
  };
};

describe('runResetPassword', () => {
  it('resets after two matching prompts, ends the sessions and writes one audit row', async () => {
    const { r, username, buyer_id } = await world();
    const s = await createSession(r.deps, { kind: 'buyer', buyer_id });
    const io = scripted([NEW, NEW]);
    const before = r.audit.length;
    const res = await runResetPassword({ deps: r.deps, tty: TTY, operator_id: 'opr_vikram', username, ...io });
    expect(res).toEqual({ ok: true, value: { revoked: 1 } });
    expect(io.asked).toHaveLength(2);
    expect(await resolveSession(r.deps, cookiePair(s.cookie))).toBeNull();
    expect((await verifyAccountLogin(r.deps, { username, password: NEW })).ok).toBe(true);
    expect(r.audit.slice(before).filter((e) => e.action === 'account.password_changed')).toHaveLength(1);
    expect(io.out.join('\n')).not.toContain(NEW);
  });

  it('refuses without a terminal, in CI and in an AI session, before it asks anything', async () => {
    for (const [tty, error] of [
      [{ isTTY: false, env: {} }, 'not_a_tty'],
      [{ isTTY: undefined, env: {} }, 'not_a_tty'],
      [{ isTTY: true, env: { CI: 'true' } }, 'ci_set'],
      [{ isTTY: true, env: { GITHUB_ACTIONS: 'true' } }, 'ci_set'],
      [{ isTTY: true, env: { CLAUDECODE: '1' } }, 'ai_session'],
    ] as const) {
      const { r, username } = await world();
      const io = scripted([NEW, NEW]);
      const res = await runResetPassword({ deps: r.deps, tty, operator_id: 'opr_v', username, ...io });
      expect(res).toEqual({ ok: false, error });
      expect(io.asked).toHaveLength(0);
      expect((await verifyAccountLogin(r.deps, { username, password: NEW })).ok).toBe(false);
    }
  });

  it('refuses two prompts that differ, a weak password, an unknown name and a missing operator; changes nothing', async () => {
    const { r, username } = await world();
    const run = (answers: string[], over: Record<string, string> = {}) =>
      runResetPassword({ deps: r.deps, tty: TTY, operator_id: 'opr_v', username, ...scripted(answers), ...over });
    expect(await run([NEW, 'another quiet harbour'])).toEqual({ ok: false, error: 'mismatch' });
    expect(await run(['tiny', 'tiny'])).toEqual({ ok: false, error: 'weak_password' });
    expect(await run([NEW, NEW], { username: 'no.such.user' })).toEqual({ ok: false, error: 'unknown_account' });
    expect(await run([NEW, NEW], { operator_id: '  ' })).toEqual({ ok: false, error: 'operator_required' });
    expect((await verifyAccountLogin(r.deps, { username, password: 'violet lamps hum softly' })).ok).toBe(true);
    expect(r.audit.filter((e) => e.action === 'account.password_changed')).toHaveLength(0);
  });
});
