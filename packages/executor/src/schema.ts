/**
 * Transport-neutral executor DTO schemas.
 *
 * This file defines the pure data contracts that may cross host-owned
 * boundaries: local HTTP, Workers RPC, structured clone, JSON, or child-process
 * payloads. These schemas intentionally contain no callback functions and no
 * host resources.
 *
 * These are pure data contracts, distinct from the runtime types in
 * `./types.ts` (which are `Data.Class`/interfaces because they may carry
 * non-serializable callback functions). Decode unknown payloads with
 * `Schema.decodeUnknown(...)` on the way in and `Schema.encode(...)` on the
 * way out.
 *
 * Naming convention: the exported schema value and its decoded TypeScript type
 * share the same name:
 *
 *   export const SandboxProviderCall = Schema.Struct(...)
 *   export type SandboxProviderCall = Schema.Schema.Type<typeof SandboxProviderCall>
 *
 * TypeScript keeps value and type namespaces separate, so this avoids the
 * noisy `FooSchema` / `Foo` split while preserving both runtime validation and
 * static typing.
 *
 * Optional fields here use `Schema.optionalWith(..., { exact: true })` because
 * they are transport fields and should encode as omitted properties when
 * absent. `Option` is reserved for values that stay inside Effect-managed
 * executor internals, such as `ExecuteRequest`.
 */
import { Schema } from "effect";

/**
 * Flattened error shape carried inside provider-call and completion
 * envelopes across transport.
 */
export const SerializedSandboxError = Schema.Struct({
  name: Schema.optionalWith(Schema.String, { exact: true }),
  message: Schema.String,
  stack: Schema.optionalWith(Schema.String, { exact: true }),
  code: Schema.optionalWith(Schema.String, { exact: true }),
});

export type SerializedSandboxError = Schema.Schema.Type<
  typeof SerializedSandboxError
>;

export const LogLevel = Schema.Literal(
  "debug",
  "error",
  "info",
  "log",
  "warn",
);

export type LogLevel = Schema.Schema.Type<typeof LogLevel>;

/** One captured `console.*` line emitted by sandbox code. */
export const CapturedLog = Schema.Struct({
  level: LogLevel,
  message: Schema.String,
  args: Schema.Array(Schema.Unknown),
});

export type CapturedLog = Schema.Schema.Type<typeof CapturedLog>;

/**
 * Pure provider data sent into sandbox code. Contains ONLY the provider
 * namespace and tool/function names — never Code Mode metadata, input/output
 * schemas, original MCP names, or annotations. Sandbox code uses this to know
 * which provider namespaces and function proxies to create.
 */
export const SandboxProviderManifest = Schema.Struct({
  name: Schema.String,
  tools: Schema.Array(Schema.String),
});

export type SandboxProviderManifest = Schema.Schema.Type<
  typeof SandboxProviderManifest
>;

/**
 * A provider function call originating from sandbox code, routed back to the
 * host via `invokeProviderCall`. Transport-neutral; a backend may carry it
 * over local HTTP, Workers RPC, or call it in memory.
 */
export const SandboxProviderCall = Schema.Struct({
  provider: Schema.String,
  tool: Schema.String,
  input: Schema.Unknown,
});

export type SandboxProviderCall = Schema.Schema.Type<
  typeof SandboxProviderCall
>;

/**
 * Result envelope returned to the sandbox for a `SandboxProviderCall`. Success
 * carries `value`; failure carries a `SerializedSandboxError`. Produced by
 * `invokeProviderCall`.
 */
export const SandboxProviderCallResult = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.optionalWith(Schema.Unknown, { exact: true }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: SerializedSandboxError,
  }),
);

export type SandboxProviderCallResult = Schema.Schema.Type<
  typeof SandboxProviderCallResult
>;

/**
 * Final sandbox completion envelope returned by a host backend and consumed by
 * `decodeSandboxCompleteResult`. Success carries `value` + captured `logs`;
 * failure carries a `SerializedSandboxError` + `logs`.
 */
export const SandboxCompleteRequest = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.optionalWith(Schema.Unknown, { exact: true }),
    logs: Schema.Array(CapturedLog),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: SerializedSandboxError,
    logs: Schema.Array(CapturedLog),
  }),
);

export type SandboxCompleteRequest = Schema.Schema.Type<
  typeof SandboxCompleteRequest
>;
