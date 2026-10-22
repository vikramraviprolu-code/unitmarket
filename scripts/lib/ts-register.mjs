// Usage: node --import ./scripts/lib/ts-register.mjs scripts/<entry>.mjs
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
