import { guard } from './guard';
import type { FixtureFile } from './fixture-schema';
import type {
  BlockReason,
  Clock,
  Logger,
  OutboundGate,
  OutboundRequest,
  PayPalOperation,
  Transport,
  TransportResult,
} from '@umsbx/contracts';

// Dry-run transport: answers PayPal-shaped responses from labelled fixtures. Opens no socket and
// never calls fetch. Every request passes the egress guard and the outbound gate, so both are
// exercised offline. Fixtures labelled docs-example or synthetic are not evidence of PayPal
// behaviour.

export interface DryRunCall {
  operation: PayPalOperation;
  scenario: string;
  /** nth call of this operation in the scenario, or null when blocked before selection. */
  step: number | null;
  /** Request headers with credentials redacted. */
  headers: Record<string, string>;
  /** Parsed JSON body, the raw text when it is not JSON, or null. */
  body: unknown;
  outcome: 'response' | 'timeout' | `blocked:${BlockReason}`;
}

export interface DryRunTransport extends Transport {
  readonly kind: 'dryrun';
  /** Test helper: a copy of every call seen so far, in order. */
  calls(): DryRunCall[];
}

const SENSITIVE = new Set([
  'authorization',
  'paypal-auth-assertion',
  'cookie',
  'proxy-authorization',
]);

function redact(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, SENSITIVE.has(k.toLowerCase()) ? '[redacted]' : v]),
  );
}

function parseBody(b: string | null): unknown {
  if (b === null) return null;
  try {
    return JSON.parse(b) as unknown;
  } catch {
    return b;
  }
}

export function createDryRunTransport(o: {
  fixtures: FixtureFile[];
  gate: OutboundGate;
  clock: Clock;
  default_scenario: string;
  log: Logger;
}): DryRunTransport {
  const bySlot = new Map<string, FixtureFile>();
  for (const f of o.fixtures) {
    bySlot.set(`${f.meta.scenario}|${f.meta.operation}|${f.meta.step}`, f);
  }
  const counters = new Map<string, number>();
  const calls: DryRunCall[] = [];

  const finish = (
    r: OutboundRequest,
    scenario: string,
    step: number | null,
    result: TransportResult,
  ): TransportResult => {
    const outcome = result.kind === 'blocked' ? (`blocked:${result.by}` as const) : result.kind;
    calls.push({
      operation: r.operation,
      scenario,
      step,
      headers: redact(r.headers),
      body: parseBody(r.body),
      outcome: outcome as DryRunCall['outcome'],
    });
    o.log.log({
      msg: 'dryrun.send',
      level: 'info',
      fields: { operation: r.operation, scenario, step, outcome },
    });
    return result;
  };

  return {
    kind: 'dryrun',
    calls: () => calls.map((c) => ({ ...c, headers: { ...c.headers } })),
    async send(r: OutboundRequest): Promise<TransportResult> {
      const started = o.clock.now().getTime();
      const scenario = r.scenario ?? o.default_scenario;

      if (!guard(r, 'dryrun').ok) {
        return finish(r, scenario, null, { kind: 'blocked', by: 'egress' });
      }
      const verdict = await o.gate.check({ operation: r.operation, amount_minor: r.amount_minor });
      // The dry-run transport never connects, so a connect_off verdict does not apply to it.
      if (!verdict.allowed && verdict.by !== 'connect_off') {
        return finish(r, scenario, null, { kind: 'blocked', by: verdict.by });
      }

      const counterKey = `${scenario}|${r.operation}`;
      const step = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, step);
      const fx = bySlot.get(`${counterKey}|${step}`);
      if (!fx) return finish(r, scenario, step, { kind: 'blocked', by: 'dry_run_miss' });

      if ('timeout' in fx.response) return finish(r, scenario, step, { kind: 'timeout' });
      const { status, headers, body } = fx.response;
      return finish(r, scenario, step, {
        kind: 'response',
        status,
        headers: { ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        duration_ms: Math.max(0, o.clock.now().getTime() - started),
      });
    },
  };
}
