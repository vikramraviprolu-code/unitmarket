export type BootRefusal = {
  code:
    | 'live_not_available'
    | 'unknown_mode'
    | 'missing_value'
    | 'weak_secret'
    | 'equal_secrets'
    | 'insecure_origin'
    | 'non_sandbox_host'
    | 'unknown_corridor'
    | 'invalid_value'
    | 'label_mode_mismatch'
    | 'transport_env_override'
    | 'env_overrides_file';
  /** the environment variable at fault; never its value */
  name: string;
};

/** sysexits EX_CONFIG */
export const BOOT_REFUSAL_EXIT_CODE = 78;

export function refusalLine(r: BootRefusal): string {
  if (r.code === 'env_overrides_file') {
    return `boot refused: ${r.code} (${r.name}). This terminal already holds ${r.name} and it differs from .env.local, so the file value is ignored. Unset it here with \`env -u ${r.name}\` or fix the file; values are never printed.`;
  }
  return `boot refused: ${r.code} (${r.name}). Fix the value in the host settings or .env.local; values are never printed.`;
}
