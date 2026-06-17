/**
 * Runtime-only executor domain types.
 *
 * Keep serializable transport contracts in `./schema.ts`. This file owns the
 * function-bearing and Effect-native values that stay inside the host runtime:
 * provider callback tables, sandbox globals, `ExecuteRequest`, and the prepared
 * backend request. Those values may contain functions and `Option`s, so they
 * are intentionally not wire schemas.
 */
import { Data, Option } from "effect";
import type { Effect } from "effect";
import type {
  CapturedLog,
  SandboxProviderManifest,
} from "./schema.js";

/**
 * Host-side callback table that lets sandbox code call MCP tools by provider
 * namespace + function name. The executor owns this shape only; it does NOT
 * redeclare MCP or Code Mode metadata.
 *
 * Important ownership boundary:
 *
 *   Code Mode runtime
 *     - owns parsed MCP tool metadata and input/output schemas
 *     - builds these provider callbacks
 *     - validates untrusted sandbox input against the tool schema
 *     - dispatches the validated call through the MCP registry
 *
 *   Executor
 *     - only knows sandbox code called `provider.tool(input)`
 *     - routes the call to the callback Code Mode supplied
 *     - serializes the callback result/failure back to the sandbox
 *     - must not depend on `McpRegistry` or redeclare per-tool schemas
 *
 * Therefore `ExecutorProviderInput` and `ExecutorProviderOutput` are `unknown`
 * at this layer. They are not "unmanaged" values; they are boundary values
 * crossing from generated sandbox JavaScript into the trusted Code Mode
 * callback wrapper. The first place that may trust the shape is the Code Mode
 * callback after it decodes the input with the MCP tool schema.
 */
export type ExecutorProviderInput = unknown;
export type ExecutorProviderOutput = unknown;
export type ExecutorProviderFailure = unknown;

export type ExecutorProviderResult = Effect.Effect<
  ExecutorProviderOutput,
  ExecutorProviderFailure
>;

export type ExecutorProviderHandler = (
  input: ExecutorProviderInput,
) => ExecutorProviderResult;

export interface ExecutorProvider {
  readonly name: string;
  readonly fns: Readonly<Record<string, ExecutorProviderHandler>>;
}

export type ExecutorProviders = ReadonlyArray<ExecutorProvider>;

/**
 * Caller-provided sandbox bindings injected as top-level identifiers into
 * sandboxed code. Not MCP tools and not provider metadata. Values stay
 * `unknown` because the executor does not own schemas for arbitrary globals.
 */
export type SandboxGlobals = Readonly<Record<string, unknown>>;

/**
 * Effect-native input to the `CodeExecutor` service — an executor-domain
 * value, not a raw JSON/API request object. Uses `Data.Class` with required
 * `Option` fields so absence is meaningful inside the Effect runtime; Code
 * Mode adapts from its schema-backed `CodeModeExecuteRequest` (optional
 * properties) into this shape at the boundary. This is a runtime value (not a
 * `Schema.Struct`) because it carries function-bearing `providers`.
 */
export class ExecuteRequest extends Data.Class<{
  readonly code: string;
  readonly globals: Option.Option<SandboxGlobals>;
  readonly providers: Option.Option<ExecutorProviders>;
  readonly timeoutMs: Option.Option<number>;
}> {}

/**
 * Fixed semantic input to a host `ExecutorBackend`, produced by
 * `prepareExecuteRequest`. A validated `Data.Class` runtime value (not a
 * schema) because `providers` contains non-serializable callback functions.
 * `providers` stays host-side and is NEVER serialized into sandbox payloads —
 * sandbox code receives only the pure `providerManifests` data.
 */
export class PreparedExecuteRequest extends Data.Class<{
  readonly code: string;
  readonly timeoutMs: number;
  readonly globals: SandboxGlobals;
  readonly providers: ExecutorProviders;
  readonly providerManifests: ReadonlyArray<SandboxProviderManifest>;
}> {}

/**
 * Adapter convenience that converts optional-property fixture input into the
 * Effect-native {@link ExecuteRequest} (optional -> `Option`). Only a
 * construction helper for tests/direct use; the service contract remains
 * `ExecuteRequest` with required `Option` fields.
 */
export const makeExecuteRequest = (options: {
  readonly code: string;
  readonly globals?: SandboxGlobals;
  readonly providers?: ExecutorProviders;
  readonly timeoutMs?: number;
}): ExecuteRequest =>
  new ExecuteRequest({
    code: options.code,
    globals: Option.fromNullable(options.globals),
    providers: Option.fromNullable(options.providers),
    timeoutMs: Option.fromNullable(options.timeoutMs),
  });

export interface ExecuteResult {
  readonly value: unknown;
  readonly logs: ReadonlyArray<CapturedLog>;
}

export interface LocalSandboxExecutorOptions {
  readonly defaultTimeoutMs?: number;
}
