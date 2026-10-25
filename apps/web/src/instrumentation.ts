// Startup (lane 15b): open, migrate and seed the database, recover what was in flight when the
// process last stopped (lane 05b recoverOnStartup), then run the job loop (due payments work and
// the access window sweep) until the process shuts down. All of it is composition.server.ts's
// startJobs; this file only decides when.
//
// BU-2 / ASM-73: a boot failure writes one line to stderr and exits (server/boot.ts), so the host's
// restart policy fires and no zombie server answers 500 to every request.
async function start(): Promise<void> {
  const { app } = await import('./server/access');
  const a = await app();
  // CO-7b (D-037): maintenance mode starts nothing. The composition already refuses to open the
  // database or build a loop; this stops before asking.
  if (a.maintenance) return;
  const jobs = await a.startJobs();
  // Stop the loop on shutdown so no pass is cut off half way when the process is asked to end.
  const stop = (): void => {
    void jobs.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

export async function register(): Promise<void> {
  // NEXT_RUNTIME is a framework flag, not configuration (S3 concerns application settings).
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { bootOrExit } = await import('./server/boot');
  await bootOrExit({
    start,
    exit: (code) => process.exit(code),
    write: (line) => void process.stderr.write(line),
    exitCode: async () => (await import('./server/access')).BOOT_REFUSAL_EXIT_CODE,
  });
}
