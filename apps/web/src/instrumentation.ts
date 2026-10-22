// Startup (lane 15): open, migrate and seed the database, then run the TEMP in-process loop.
// Lane 05b owns the real job loop (packages/jobs startLoop) and recoverOnStartup; until it is on
// main this registers only the access window sweep. TEMP-until-05b.
export async function register(): Promise<void> {
  // NEXT_RUNTIME is a framework flag, not configuration (S3 concerns application settings).
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { app } = await import('./server/access');
  const a = await app();
  const timer = setInterval(() => {
    void a.engine.sweep().catch(() => undefined);
  }, 30_000);
  timer.unref();
}
