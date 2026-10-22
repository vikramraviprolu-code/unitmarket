export interface Finding {
  rule: string;
  where: string;
  length: number;
  seed_index?: number;
}
export interface ScanOptions {
  seeds?: string[];
  where?: string;
  label?: string;
}
export const SHAPES: { name: string; re: RegExp }[];
export function scanText(text: string, o?: ScanOptions): Finding[];
export function scanLines(lines: string[], o?: ScanOptions): Finding[];
export function scanRows(rows: unknown[], o?: ScanOptions): Finding[];
export function countDebugIds(rows: { debug_id?: unknown }[]): number;
export function selfTest(): { ok: boolean; missed: string[]; false_alarms: string[] };
