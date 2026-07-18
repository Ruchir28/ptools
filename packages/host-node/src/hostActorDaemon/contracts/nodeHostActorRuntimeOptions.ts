/**
 * Resolved physical settings shared by every actor created by one Node daemon.
 *
 * `nodeHostActorStateNamespace.ts` produces this value once from explicit
 * overrides and Node process defaults. The daemon activation service captures
 * it; individual actors receive only the concrete storage/MCP/sandbox Layers
 * derived from it, not the settings object itself.
 */
export interface NodeHostActorRuntimeOptions {
  /** Absolute root owned by this daemon state namespace. */
  readonly internalStateDirectory: string;
  /** OS-keyring application namespace shared by actors in this daemon. */
  readonly keyringServiceName: string;
  /** Optional Deno executable path/name used by each actor's sandbox runtime. */
  readonly denoExecutable?: string;
}
