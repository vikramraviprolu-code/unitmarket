// POB-I1 (D-089): the background run of a web import. The loop knows nothing of the import rules: it is given
// a runner with two calls and a worker that runs it OFF the pass, so a batch that takes a minute (100 items,
// each a fetch) does not hold up the payments work or the access windows. One chain at a time per process.
import type { Logger } from '@umsbx/contracts';

/** What the loop needs from the import: recover once per term, then run queued batches one at a time. */
export interface ImportRunner {
  /** Marks every queued or running batch interrupted. The loop calls it at the start of a term (one process). */
  recover(): Promise<unknown>;
  /** Takes one queued batch and runs it. `ran: false` when there is nothing to run. */
  runNext(): Promise<{ ran: boolean }>;
}

export interface ImportWorker {
  /** The runner's recover, passed through (so a caller holds one object for both). */
  recover(): Promise<unknown>;
  /** Starts a chain of runNext calls unless one is running or the worker is stopped. Returns at once. */
  kick(): void;
  /** Resolves when no chain is running. */
  idle(): Promise<void>;
  /** No new chain; the batch in progress is waited for, and no further batch is asked for. */
  stop(): Promise<void>;
}

export function createImportWorker(runner: ImportRunner, log: Logger): ImportWorker {
  let current: Promise<void> | null = null;
  let stopped = false;
  const chain = async (): Promise<void> => {
    try {
      while (!stopped) {
        const r = await runner.runNext();
        if (!r.ran) return;
      }
    } catch (e) {
      // The chain ends; the next kick tries again. Only the message is kept.
      log.log({
        msg: 'jobs.imports.failed',
        level: 'error',
        fields: { error: e instanceof Error ? e.message : 'unknown' },
      });
    }
  };
  return {
    recover: () => runner.recover(),
    kick(): void {
      if (stopped || current !== null) return;
      current = chain().finally(() => {
        current = null;
      });
    },
    idle: () => current ?? Promise.resolve(),
    async stop(): Promise<void> {
      stopped = true;
      await current;
    },
  };
}
