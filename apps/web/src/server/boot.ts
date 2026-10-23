// Boot failure handling (BU-2, ASM-73). Next 15.5 only logs a failed register() and keeps serving, which
// leaves a server that answers 500 to every request and that the host's restart policy never restarts.
// So a failure while booting (a refused database, a refused configuration, a failed start) writes ONE
// line to stderr and exits with the boot-refusal code. The process, stderr and the exit code are passed
// in by instrumentation.ts, so this file touches no global and a test can drive it with fakes.
const FALLBACK_EXIT_CODE = 78; // sysexits EX_CONFIG, the value of BOOT_REFUSAL_EXIT_CODE

export interface BootDeps {
  /** Opens the app and starts the jobs. */
  start(): Promise<void>;
  /** Ends the process. */
  exit(code: number): void;
  write(line: string): void;
  /** BOOT_REFUSAL_EXIT_CODE; may fail when the module that holds it is the one that failed to load. */
  exitCode(): Promise<number>;
}

/** One log-safe line: the error name and a short message with every URL (and its userinfo) cut out. */
export function bootFailureLine(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error';
  const raw = e instanceof Error ? e.message : String(e);
  const message = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[url]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  return `boot failed (${name}): ${message}. The process exits so the host can restart it.\n`;
}

export async function bootOrExit(d: BootDeps): Promise<void> {
  try {
    await d.start();
  } catch (e) {
    let code = FALLBACK_EXIT_CODE;
    try {
      code = await d.exitCode();
    } catch {
      /* keep the fallback */
    }
    d.write(bootFailureLine(e));
    d.exit(code);
  }
}
