// The maintenance flag reader (CO-7b, D-037). The owner creates the flag file in the host shell
// (`touch /var/data/ums-maintenance`) and removes it there; this module only LOOKS at it, once, when the
// app boots. It imports lstatSync and nothing else that touches files, and
// scripts/maintenance-flag.test.ts pins that. No other file in apps/ or packages/ may name the flag.
//
// Fail closed toward doing less: the flag counts as set unless lstat says, for sure, that it is absent
// from a folder that exists. A missing parent folder (the disk is not mounted) or any other error
// (permission, I/O) reads as set, so a broken disk never silently skips maintenance mode.
import { lstatSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

export type MaintenanceReading =
  { on: false } | { on: true; why: 'flag_present' | 'flag_unreadable' | 'flag_dir_missing' };

export interface MaintenanceSeams {
  /** Test seam: defaults to fs.lstatSync. */
  lstat?: (path: string) => Stats;
}

const missing = (e: unknown): boolean =>
  (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** `path` is Config.maintenance_flag. Null (no flag configured) reads as off. Touches nothing. */
export function readMaintenanceFlag(
  path: string | null,
  seams: MaintenanceSeams = {},
): MaintenanceReading {
  if (path === null) return { on: false };
  const lstat = seams.lstat ?? ((p: string): Stats => lstatSync(p));
  try {
    if (!lstat(dirname(path)).isDirectory()) return { on: true, why: 'flag_dir_missing' };
  } catch {
    return { on: true, why: 'flag_dir_missing' };
  }
  try {
    lstat(path); // a file, a folder, a link, even a dangling link: something is there
    return { on: true, why: 'flag_present' };
  } catch (e) {
    return missing(e) ? { on: false } : { on: true, why: 'flag_unreadable' };
  }
}
