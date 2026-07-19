/**
 * @file Physical settings shared by actor runtimes in one Node daemon.
 *
 * `daemonProcess/nodeHostActorStateNamespace.ts` resolves this value once from
 * explicit overrides and Node defaults. The daemon-side activator captures it;
 * individual actors receive only derived storage, MCP, and sandbox Layers.
 */
export interface NodeHostActorRuntimeOptions {
  /** Absolute root owned by this daemon state namespace. */
  readonly internalStateDirectory: string;
  /** OS-keyring application namespace shared by actors in this daemon. */
  readonly keyringServiceName: string;
  /** Optional Deno executable path/name used by each actor's sandbox runtime. */
  readonly denoExecutable?: string;
}
