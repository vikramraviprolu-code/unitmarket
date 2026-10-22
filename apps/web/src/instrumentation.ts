// Startup (lane 15b): open, migrate and seed the database, recover what was in flight when the
// process last stopped (lane 05b recoverOnStartup), then run the job loop (due payments work and
// the access window sweep) until the process shuts down. All of it is composition.server.ts's
// startJobs; this file only decides when.
export async function register(): Promise<void> {
  // NEXT_RUNTIME is a framework flag, not configuration (S3 concerns application settings).
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { app } = await import('./server/access');
  const a = await app();
  const jobs = await a.startJobs();
  // Stop the loop on shutdown so no pass is cut off half way when the process is asked to end.
  const stop = (): void => {
    void jobs.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
