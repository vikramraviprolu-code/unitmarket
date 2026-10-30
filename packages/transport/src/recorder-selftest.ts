import { buildRecordings, canaryForms, residueRule } from './recorder';
import type { RecorderOptions } from './recorder';
import { exchange, hostileExchange, host, liveInputs, makeCanaries } from './recorder-corpus';

// Self test: canaries are built at runtime; the sabotage cases prove the checks are alive.
export interface SelfTestResult {
  ok: boolean;
  failures: string[];
  checked: number;
}

export async function recorderSelfTest(): Promise<SelfTestResult> {
  const failures: string[] = [];
  let checked = 0;
  const expect = (cond: boolean, label: string) => {
    checked += 1;
    if (!cond) failures.push(label);
  };
  const c = makeCanaries();
  const base: RecorderOptions = {
    recorded_at: '2026-01-01T00:00:00Z',
    origin: 'sandbox-recording: recorder self-test, synthetic input',
  };

  // 1. hostile exchange: no canary survives, in any encoding
  const r = await buildRecordings([hostileExchange(c)], { ...base, canaries: c.all });
  expect(r.ok, 'hostile exchange is redacted and verified clean');
  if (r.ok) {
    const low = r.files
      .map((f) => f.text)
      .join('\n')
      .toLowerCase();
    for (const [i, v] of c.all.entries()) {
      for (const form of canaryForms(v))
        expect(!low.includes(form), `canary ${i} survived in a form`);
    }
  }
  // 2. live and non-sandbox input is refused
  for (const [name, input] of Object.entries(liveInputs())) {
    const x = await buildRecordings([input], base);
    expect(!x.ok && x.refusal.code === 'live_host', `live input refused: ${name}`);
  }
  // 3. sabotage: a canary no rule knows about must stop the write
  const sab = await buildRecordings(
    [
      exchange({
        response: { status: 200, headers: {}, body: { id: '5O190127TN364715T', memo: c.plain } },
      }),
    ],
    { ...base, canaries: [c.plain] },
  );
  expect(!sab.ok && sab.refusal.code === 'canary_survived', 'surviving canary refuses the build');
  // 4. the residue check is alive: dirty text per category is refused
  const dirtyBodies: Record<string, unknown> = {
    email: { memo: `${'a'}@${['dirty', 'example'].join('.')}` },
    token: { memo: c.token },
    key: { access_token: 'abc' },
  };
  for (const [label, body] of Object.entries(dirtyBodies)) {
    const text = JSON.stringify({
      meta: { source: 'sandbox-recording' },
      response: { body },
    });
    expect(residueRule(text, []) !== null, `residue check catches ${label}`);
  }
  // 5. B-13: a documentation link is dropped, never kept
  const docsUrl = `https://${['developer', 'paypal', 'com'].join('.')}/docs/api/orders/v2/#x`;
  const dl = await buildRecordings(
    [
      exchange({
        response: { status: 422, headers: {}, body: { information_link: docsUrl } },
      }),
    ],
    base,
  );
  expect(
    dl.ok &&
      dl.summary.redactions['foreign url'] === 1 &&
      !dl.files.some((f) => f.text.includes('docs/api')),
    'documentation link is dropped and counted',
  );
  expect(
    residueRule(JSON.stringify({ x: docsUrl }), []) !== null,
    'residue check catches a docs link',
  );
  expect(host.live.length > 0, 'corpus loaded');
  return { ok: failures.length === 0, failures, checked };
}
