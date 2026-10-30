// @umsbx/config: the only reader of process.env; refuses unsafe boots (architecture 6, nfr P15).
export const PACKAGE_NAME = '@umsbx/config' as const;
export type { Config, Mode, OutboundScope } from './schema';
export type { BootRefusal } from './refusal';
export { BOOT_REFUSAL_EXIT_CODE } from './refusal';
export {
  bootOrExit,
  findEnvOverride,
  loadConfig,
  loadConfigFromProcess,
  terminalEnv,
} from './load';
export type { EnvFileReader, ProcessLoadOptions } from './load';
export { makeSecret } from './secret';
export { MAX_LEARN_WINDOW_MS, webhookLearnWindow } from './schema';
export { readMaintenanceFlag } from './maintenance';
export type { MaintenanceReading } from './maintenance';
