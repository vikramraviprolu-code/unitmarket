import { describe, expect, it } from 'vitest';
import * as production from './index';
import * as testing from './testing';
import { PACKAGE_NAME } from './index';

describe('@umsbx/db scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@umsbx/db');
  });
  it('M4: resetDatabase is not on the production entry; it lives on the testing entry', () => {
    expect('resetDatabase' in production).toBe(false);
    expect(typeof testing.resetDatabase).toBe('function');
  });
});
