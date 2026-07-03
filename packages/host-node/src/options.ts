import type { CodeModeClientHandle } from "@ptools/code-mode-api";
import { Data, Redacted } from "effect";
import type { LocalSandboxExecutorOptions } from "./executor/localExecutor.js";

export const DEFAULT_HOST_ID = "node-local";
export const DEFAULT_NODE_PUBLIC_ORIGIN = "http://127.0.0.1:19876";
export const NODE_INTERNAL_ACCESS_TOKEN = Redacted.make("ptools-node-internal");
export const DEFAULT_AUTH_SERVICE_NAME = "ptools-mcp-oauth";

export type NodeEnv = Readonly<Record<string, string | undefined>>;

export class HostNodeError extends Data.TaggedError("HostNodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NodeAuthOptions {
  readonly serviceName?: string;
  readonly autoOpen?: boolean;
}

/**
 * Node host startup options around the shared ptools config source.
 *
 * MCP servers and executor timeouts come from the authored ptools config loaded
 * by `configPath`, `--config`, `PTOOLS_CONFIG`, or default config discovery.
 * These options only describe Node platform context for finding config,
 * resolving secrets, storing credentials, and mounting the local Host HTTP
 * API.
 */
export interface NodeCodeModeHostOptions {
  /** CLI-style arguments used for config discovery when no explicit config path is passed. */
  readonly argv?: ReadonlyArray<string>;
  /** Working directory for config discovery and relative explicit config paths. */
  readonly cwd?: string;
  /** Environment used for config discovery, `${env:...}` secret resolution, and auth defaults. */
  readonly env?: Record<string, string | undefined>;
  /** Logical Host API id. Defaults to `node-local`. */
  readonly hostId?: string;
  /** Node credential-store and local browser OAuth behavior. */
  readonly auth?: NodeAuthOptions;
  /** Node-local sandbox process options. Config file executor settings still own runtime timeouts. */
  readonly executor?: Pick<LocalSandboxExecutorOptions, "denoExecutable">;
  /** Public origin used by Host HTTP links and the Node loopback listener. */
  readonly publicOrigin?: string;
}

export type { CodeModeClientHandle };
