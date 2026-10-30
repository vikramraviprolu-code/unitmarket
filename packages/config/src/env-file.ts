// The .env.local reader for the override guard (F8): readFileSync only. A missing file reads as null.
import { readFileSync } from 'node:fs';
import type { EnvFileReader } from './load';

export const defaultReadEnvFile: EnvFileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};
