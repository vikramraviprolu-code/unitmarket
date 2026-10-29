// DP-5b: the banner tone and the polling rule of the order page, from the order view alone. Pure; the
// same functions are fed a real pack from the engine in order-status.state.test.ts.
import { describe, expect, it } from 'vitest';
import { keepPolling, orderTone } from './order-status';

type V = Parameters<typeof keepPolling>[0];
const item = (kind?: string): V['items'][number] => ({
  article_id: 'art_x',
  title: 'T',
  access: 'locked',
  ...(kind === undefined ? {} : { kind: kind as never, line: 'x' }),
});
const view = (status: string, kinds: (string | undefined)[], open_case = false): V => ({
  status,
  items: kinds.map(item),
  open_case: open_case ? { case_id: 'cas_1', state: 'open', buyer_message: 'm' } : null,
});

describe('order tone', () => {
  it('paid and paid_partial without a hold are success', () => {
    expect(orderTone(view('paid', ['ready', 'ready']))).toBe('success');
    expect(orderTone(view('paid_partial', ['ready', 'declined']))).toBe('success');
    expect(orderTone(view('paid', [undefined]))).toBe('success');
  });
  it('any item on hold is a warning, whatever the status says', () => {
    expect(orderTone(view('paid_partial', ['ready', 'hold']))).toBe('warn');
    expect(orderTone(view('paid', ['ready', 'hold']))).toBe('warn');
    expect(orderTone(view('capture_requested', ['hold', 'confirming']))).toBe('warn');
  });
  it('frozen is a warning, failed an error, the rest info', () => {
    expect(orderTone(view('frozen', ['hold', 'hold']))).toBe('warn');
    expect(orderTone(view('frozen', []))).toBe('warn');
    expect(orderTone(view('failed', ['declined']))).toBe('error');
    expect(orderTone(view('awaiting_buyer', ['awaiting']))).toBe('info');
    expect(orderTone(view('abandoned', ['abandoned']))).toBe('info');
  });
});

describe('polling', () => {
  it('polls while the order is not settled', () => {
    expect(keepPolling(view('awaiting_buyer', ['awaiting']))).toBe(true);
    expect(keepPolling(view('capture_requested', ['confirming']))).toBe(true);
  });
  it('stops when settled with no hold', () => {
    expect(keepPolling(view('paid', ['ready']))).toBe(false);
    expect(keepPolling(view('paid_partial', ['ready', 'declined']))).toBe(false);
    expect(keepPolling(view('failed', []))).toBe(false);
    expect(keepPolling(view('abandoned', []))).toBe(false);
  });
  it('a hold keeps polling until its case line shows, in every settled status', () => {
    for (const status of ['frozen', 'paid_partial', 'paid']) {
      expect(keepPolling(view(status, ['ready', 'hold'])), status).toBe(true);
      expect(keepPolling(view(status, ['ready', 'hold'], true)), status).toBe(false);
    }
    expect(keepPolling(view('frozen', [], false))).toBe(true);
    expect(keepPolling(view('frozen', [], true))).toBe(false);
  });
});
