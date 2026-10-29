// DP-5b (H1): what the static cancel page shows for the `ref` PayPal's cancel URL carries. The ref is
// only shape-checked and put in a link; nothing is looked up. Garbage gets no link and no promise.
import { describe, expect, it } from 'vitest';
import {
  CANCEL_BACK_LINK,
  CANCEL_BODY,
  CANCEL_BODY_NO_REF,
  CANCEL_WINDOW_LINE,
} from './composite-copy';
import { cancelView } from './cancel-view';

const REF = 'ord_0123456789abcdefghjkmnpqrs';

describe('cancel page with a valid ref', () => {
  it('links back to the return page with exactly that ref and makes the promise the link keeps', () => {
    const v = cancelView(REF);
    expect(v.back_href).toBe(`/checkout/return?ref=${REF}`);
    expect(v.body).toBe(CANCEL_BODY);
    expect(v.window_line).toBe(CANCEL_WINDOW_LINE);
    expect(CANCEL_WINDOW_LINE).toBe(
      'If the order window is still open, you can go back to your order and approve this payment.',
    );
    expect(CANCEL_BACK_LINK).toBe('Go back to your order');
  });
  it('accepts the id alphabet of the engine (prefix, underscore, letters and digits)', () => {
    for (const ok of ['ord_1', 'ref_w10', 'ord_ABCDEF0123456789abcdef']) {
      expect(cancelView(ok).back_href, ok).toBe(`/checkout/return?ref=${ok}`);
    }
  });
});

describe('cancel page with a missing or bad ref', () => {
  const bad: (string | string[] | undefined)[] = [
    undefined,
    '',
    ' ',
    'x'.repeat(65),
    'x'.repeat(201),
    '../etc/passwd',
    'ord_1/../../x',
    'ord_1/x',
    'ord_1?next=/ops',
    'ord_1#frag',
    'ord_1&x=1',
    'ord_ 1',
    'ord_1\n',
    '%2e%2e',
    'ord_1%2Fx',
    'javascript:alert(1)',
    'https://evil.example/x',
    '//evil.example',
    '"><script>',
    ['ord_1', 'ord_2'],
    [],
  ];
  it.each(bad.map((b) => [JSON.stringify(b), b] as const))('%s: no link, no sentence', (_l, v) => {
    const r = cancelView(v);
    expect(r.back_href).toBeNull();
    expect(r.window_line).toBeNull();
    expect(r.body).toBe(CANCEL_BODY_NO_REF);
  });
  it('the fallback says only what the page can know', () => {
    expect(CANCEL_BODY_NO_REF).toBe(
      'You did not approve this payment at PayPal. Nothing was charged for this payment.',
    );
  });
});
