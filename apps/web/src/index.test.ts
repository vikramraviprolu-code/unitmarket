import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@umsbx/web scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@umsbx/web');
  });
});
