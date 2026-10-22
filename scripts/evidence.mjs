// Runs the CI script set and writes an evidence report (SOP 22, nfr.md 1.3).
//
//   node scripts/evidence.mjs --lane <id> [--date YYYY-MM-DD] [--out-dir docs/evidence]
//        [--id <raw id>]... [--pnpm "<cmd>"] [--step "name=command"]...
//
// Writes <out-dir>/<lane>-<date>.md holding, per step: the command, the exit code and the test
// counts. Command output is never copied into the report. Ids passed with --id are shortened to
// their first four characters; the commit is shortened to six. Any run of sixteen or more
// identifier characters in a command is replaced by [long], so a pasted secret cannot land in the file. The date defaults to the date of the
// HEAD commit (no clock read). Exit 0 when every step exits 0, 1 otherwise, 2 on bad arguments.
// Coverage (MAINT-6) is not part of the set: it needs @vitest/coverage-v8, which is not approved.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const all = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const one = (name) => all(name)[0];

/** First four characters plus an ellipsis; ids of six characters or fewer are kept. */
export const sanitiseId = (id) => (id.length <= 6 ? id : `${id.slice(0, 4)}...`);

function main() {
  const lane = one('--lane');
  if (!lane || !/^[A-Za-z0-9._-]{1,32}$/.test(lane)) {
    console.error('evidence: --lane <id> is required');
    return 2;
  }
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  let date = one('--date');
  if (!date) {
    const r = git('log', '-1', '--format=%cs');
    date = r.status === 0 ? r.stdout.trim() : '';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('evidence: pass --date YYYY-MM-DD (no commit date available)');
    return 2;
  }
  const outDir = resolve(ROOT, one('--out-dir') ?? 'docs/evidence');
  const pnpm = one('--pnpm') ?? 'corepack pnpm';
  const defaults = [
    'format:check',
    'lint',
    'typecheck',
    'test',
    'check:isolation',
    'check:no-live-host',
    'check:secrets-names',
    'check:fixtures',
  ].map((s) => ({ name: s, cmd: `${pnpm} ${s}` }));
  const steps = all('--step').length
    ? all('--step').map((s) => {
        const k = s.indexOf('=');
        return { name: s.slice(0, k), cmd: s.slice(k + 1) };
      })
    : defaults;
  if (steps.some((s) => !s.name || !s.cmd)) {
    console.error('evidence: --step needs "name=command"');
    return 2;
  }

  const redact = (text) => text.replace(/[A-Za-z0-9_-]{16,}/g, '[long]');
  const count = (out, word) => {
    const line =
      out
        .split('\n')
        .filter((l) => /^\s*Tests\b/.test(l))
        .pop() ?? '';
    const m = new RegExp(`(\\d+) ${word}`).exec(line);
    return m ? Number(m[1]) : 0;
  };

  const rows = [];
  for (const s of steps) {
    const r = spawnSync(s.cmd, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const passed = count(out, 'passed');
    const failed = count(out, 'failed');
    rows.push({ ...s, code: r.status ?? 1, passed, failed, counted: passed + failed > 0 });
    console.log(`evidence: ${s.name}: exit ${r.status ?? 1}`);
  }

  const ok = rows.every((r) => r.code === 0);
  const sha = git('rev-parse', '--short=6', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const ids = all('--id').map(sanitiseId);
  const md = [
    `# Evidence: lane ${lane}, ${date}`,
    '',
    `Result: **${ok ? 'PASS' : 'FAIL'}**`,
    '',
    `- Branch: ${branch.status === 0 ? branch.stdout.trim() : 'unknown'}`,
    `- Commit: ${sha.status === 0 ? sha.stdout.trim() : 'unknown'}`,
    `- Node: ${process.version}`,
    '- Mode: offline. No PayPal contact, no credentials, no environment values recorded.',
    '',
    '| Step | Command | Exit | Tests |',
    '| ---- | ------- | ---- | ----- |',
    ...rows.map(
      (r) =>
        `| ${r.name} | \`${redact(r.cmd).replace(/\|/g, '/')}\` | exit ${r.code} | ${
          r.counted ? `${r.passed} passed, ${r.failed} failed` : '-'
        } |`,
    ),
    '',
    '## Sanitised ids',
    '',
    ...(ids.length ? ids.map((i) => `- ${i}`) : ['- none']),
    '',
    '## Not covered by this report',
    '',
    '- Coverage gate (MAINT-6): waits for an approved coverage package.',
    '- Mutation score (MAINT-4), bundle scan (A-25), `pnpm audit --prod` (SUP-2), gitleaks (SUP-6): run as',
    '  their own steps or CI jobs and attached by the author.',
    '',
  ].join('\n');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${lane}-${date}.md`), md);
  console.log(`evidence: wrote ${lane}-${date}.md (${ok ? 'PASS' : 'FAIL'})`);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
