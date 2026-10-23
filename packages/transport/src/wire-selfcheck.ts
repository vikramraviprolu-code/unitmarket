// What the production Wire reports about itself, without doing any I/O (BU-1). The Wire module
// (wire-https.ts, imported by sandbox.ts alone) registers three read-only probes when it loads; this
// file only holds them and shapes the answer, so it imports no network module and no Wire.
// Fail-closed: before a Wire has registered, the answer says the environment is overridden and the
// builtins are not intact.

export interface WireSelfCheck {
  /** The HTTP client the production Wire uses. */
  impl: 'node-https';
  /** A proxy, trust-store, loader or Node flag override is present right now. */
  env_override: boolean;
  /** https.request, tls.connect and dns.lookup are still the functions captured at load. */
  builtins_intact: boolean;
  /** globalThis.fetch is not the one that existed at load. A report only: the Wire never uses it. */
  global_fetch_changed_since_load: boolean;
}

export interface WireProbe {
  envOverride(): boolean;
  builtinsIntact(): boolean;
  fetchChanged(): boolean;
}

let probe: WireProbe | null = null;

/** Called once by the Wire module at load. A second registration in the same module registry throws. */
export function registerWireProbe(p: WireProbe): void {
  if (probe !== null) throw new Error('wire probe already registered');
  probe = p;
}

function safely(f: () => boolean, onError: boolean): boolean {
  try {
    return f();
  } catch {
    return onError;
  }
}

export function wireSelfCheck(): WireSelfCheck {
  const p = probe;
  if (p === null)
    return {
      impl: 'node-https',
      env_override: true,
      builtins_intact: false,
      global_fetch_changed_since_load: false,
    };
  return {
    impl: 'node-https',
    env_override: safely(() => p.envOverride(), true),
    builtins_intact: safely(() => p.builtinsIntact(), false),
    global_fetch_changed_since_load: safely(() => p.fetchChanged(), true),
  };
}
