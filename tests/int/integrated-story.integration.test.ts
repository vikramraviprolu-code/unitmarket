// INT-E2E (item E2E.1): the integrated story end to end, S01 to S12, through the route handlers and the web
// composition of the booted offline app (dry-run, nothing reaches PayPal or any network). The steps are in
// story.ts; each is one titled test here, in order. After the story: the journal table of the spec holds exactly
// (printed), the deep scans find no canary in any seller or v1 operator answer, INV-T2 is empty and the
// in-process verifier exits 0. This file changes no product code: a failing step is a stop-and-report.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STEPS, bootStory, canaries, checkTable, printTable, scannedAnswers } from './story';
import type { Rig } from './story';
import { STORY_START, unattributed, verifyInProcess } from './support';

vi.mock('server-only', () => ({}));

describe('INT-E2E the integrated story', () => {
  let rig: Rig;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(STORY_START));
    rig = await bootStory();
  }, 180_000);
  afterAll(async () => {
    await rig?.app.close();
    vi.useRealTimers();
  });

  for (const s of STEPS) {
    it(`${s.id} ${s.title}`, async () => {
      await s.run(rig);
    }, 180_000);
  }

  it('the story ran every step in order', () => {
    expect(STEPS.map((s) => s.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('the journal table of the spec holds exactly, one marker per row in its named view', async () => {
    const { lines, problems } = await checkTable(rig);
    process.stdout.write(`\nINT-E2E journal table\n${printTable(lines)}\n`);
    if (problems.length > 0)
      process.stdout.write(`\nINT-E2E table problems\n${problems.join('\n')}\n`);
    expect(lines).toHaveLength(18);
    expect(problems).toEqual([]);
  }, 180_000);

  it('the deep scans find no canary in any seller answer or v1 operator answer', async () => {
    const marks = await canaries(rig);
    const kinds = new Set(marks.map((m) => m.name));
    for (const k of [
      'buyer id',
      'buyer display name',
      'agent key id',
      'req_id',
      'ip_hash',
      'PayPal id',
    ])
      expect(kinds, `canary ${k}`).toContain(k);
    const answers = await scannedAnswers(rig);
    const leaks: string[] = [];
    for (const a of answers) {
      for (const m of marks) if (a.text.includes(m.value)) leaks.push(`${a.name}: ${m.name}`);
      // ua_family is a short word ("browser"), so the scan looks for the field instead of the value.
      for (const field of ['"ua_family"', '"ip_hash"', '"req_id"', '"on_behalf_of"'])
        if (a.text.includes(field)) leaks.push(`${a.name}: field ${field}`);
    }
    process.stdout.write(
      `\nINT-E2E deep scan: ${String(answers.length)} answers, ${String(marks.length)} canaries, ${String(leaks.length)} leaks\n`,
    );
    if (leaks.length > 0) process.stdout.write(`${leaks.join('\n')}\n`);
    expect(leaks).toEqual([]);
  }, 180_000);

  it('INV-T2 is empty and the in-process verifier exits 0', async () => {
    const bare = await unattributed(rig.app);
    if (bare.length > 0) process.stdout.write(`\nINT-E2E unattributed\n${bare.join('\n')}\n`);
    expect(bare).toEqual([]);
    const v = await verifyInProcess(rig.app);
    process.stdout.write(`\nINT-E2E trace:verify (in-process)\n${v.lines.join('\n')}\n`);
    expect(v.unattributed).toBe(0);
    expect(v.invariants).toEqual([]);
    expect(v.code).toBe(0);
  }, 180_000);
});
