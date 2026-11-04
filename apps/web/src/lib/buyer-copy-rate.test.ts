// MC2-L5 follow-up F1: a search that found nothing because no exchange rate was usable says so.
import { describe, expect, it } from 'vitest';
import { discoverNoMatchView } from './buyer-copy';
import { NO_RATE_NOTE } from './buyer-price';

describe('discoverNoMatchView with a missing rate', () => {
  it('adds the note, and keeps the older answers as they were', () => {
    expect(discoverNoMatchView([], true).no_rate).toBe(NO_RATE_NOTE);
    expect(discoverNoMatchView(['above_ceiling'], true).no_rate).toBe(NO_RATE_NOTE);
    expect(discoverNoMatchView([]).no_rate).toBeNull();
    expect(discoverNoMatchView([], false).no_rate).toBeNull();
    const held = discoverNoMatchView(['already_owned'], true);
    expect(held.open_order).not.toBeNull();
    expect(held.no_rate).toBe(NO_RATE_NOTE);
    expect(discoverNoMatchView([], true).nothing_fits).toBe(true);
  });
});
