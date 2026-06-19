/**
 * @file Shared Sandbox Kernel
 *
 * This module implements the platform-agnostic sandbox execution engine.
 * It coordinates the execution of pre-compiled or pre-loaded user code
 * while providing uniform logging, error handling, and asynchronous provider tracking.
 *
 * ### Architectural Role & Security Boundary
 *
 * This file runs entirely inside the UNTRUSTED sandbox environment (e.g., a restricted
 * Deno subprocess or a Cloudflare Worker isolate). To maintain a strict security boundary:
 * 1. **No Host Imports**: It does not import Effect, Node, Deno, or Cloudflare APIs.
 * 2. **No Direct Host Access**: It has no direct access to the filesystem, network, or environment.
 * 3. **Standardized Communication**: Any interaction with trusted host capabilities (such as MCP tools)
 *    must cross the process/isolate boundary through the required `SandboxHostBridge`.
 *
 * ### Key Responsibilities
 *
 * - **Provider Proxying**: Wraps the raw provider manifests in standard JavaScript `Proxy`-like
 *   objects, exposing them as natural namespaces (e.g., `sheets.read(...)`) to the user code.
 * - **Log Capturing**: Intercepts `console` calls to capture structured logs without polluting
 *   the standard output streams of the sandbox.
 * - **Async Tracking**: Tracks all in-flight provider calls in a pending Set, preventing the
 *   sandbox from emitting a completion signal while background operations are still running.
 * - **Error Standardization**: Serializes and deserializes errors crossing the host-sandbox boundary
 *   to ensure consistent stack traces and error codes.
 */

import type {
  CapturedLog,
  LogLevel,
  SerializedSandboxError,
} from "../protocol.js";
import type {
  SandboxHostBridge,
  SandboxKernel,
  SandboxKernelExecution,
  SandboxProgramResult,
} from "./types.js";

const logLevels: ReadonlyArray<LogLevel> = [
  "debug",
  "error",
  "info",
  "log",
  "warn",
];

/**
 * Initializes the shared kernel with the platform bridge required to reach the
 * trusted host.
 *
 * Deno supplies a stdio bridge; a Dynamic Worker supplies a Workers RPC bridge.
 * The factory verifies the bridge once and returns the only operation generated
 * code entrypoints need: `kernel.execute(...)`.
 *
 * This is a plain JavaScript factory rather than an Effect service because it
 * executes inside the untrusted sandbox where Effect is intentionally absent.
 */
export const makeSandboxKernel = (bridge: SandboxHostBridge): SandboxKernel => {
  if (typeof bridge?.invokeProvider !== "function") {
    throw new TypeError("SandboxHostBridge.invokeProvider must be a function");
  }

  return {
    execute: (execution) => runSandboxProgram(execution, bridge),
  };
};

/**
 * Central execution loop of the sandbox kernel.
 *
 * This function remains private to prevent any bypass of the required host bridge composition.
 * It builds dynamically bounded proxy objects for every declared provider tool, executes the
 * compiled program function by injecting these capabilities directly into its scope, and
 * ensures that all concurrent background promises are settled before finalizing.
 *
 * ### Architectural Trade-offs & Behaviors:
 * 1. **Proxy Injection**: Instead of giving user code raw access to bridge APIs, it constructs a
 *    clean, natural JavaScript object map matching the provider's namespace and tool schema.
 *    User code simply calls `provider.tool(args)` as a local async function.
 * 2. **Isolate Suspend Prevention**: Untrusted code might trigger background operations or call
 *    provider tools without awaiting them. To prevent the host from prematurely destroying or
 *    evicting the sandbox subprocess/isolate while these RPC operations are active, the kernel
 *    tracks every in-flight promise in a `pendingProviderCalls` Set and guarantees they are all
 *    settled (`Promise.all`) prior to completion.
 * 3. **Error Isolation**: Standard try-catch-finally wrapping prevents internal VM exceptions
 *    from causing unhandled process rejections. All outcomes are gracefully compiled into a
 *    standardized `SandboxProgramResult` envelope.
 */
const runSandboxProgram = async (
  execution: SandboxKernelExecution,
  bridge: SandboxHostBridge,
): SandboxProgramResult => {
  const logs: Array<CapturedLog> = [];
  const pendingProviderCalls = new Set<Promise<void>>();
  let nextCallId = 0;

  // Map individual provider tool manifests into callable async function namespaces
  const providers = Object.fromEntries(
    execution.providers.map((provider) => [
      provider.name,
      Object.fromEntries(
        provider.tools.map((tool) => [
          tool,
          (input: unknown): Promise<unknown> => {
            const callId = String(nextCallId++);
            const invocation = bridge
              .invokeProvider({ callId, provider: provider.name, tool, input })
              .then((result) => {
                // Ensure the response matches this specific RPC request to prevent race conditions
                if (result.callId !== callId) {
                  throw new Error(
                    `Provider result callId mismatch: expected ${callId}, received ${result.callId}`,
                  );
                }
                if (!result.ok) {
                  // Propagate host-side failures as regular throwables inside the sandbox runtime
                  throw deserializeSandboxError(result.error);
                }
                return result.value;
              });

            // Cast tracking promise to resolve cleanly (ignoring failure) so that the pending set
            // can block VM termination without throwing unhandled rejections during global settlement.
            const tracked = invocation.then(
              () => undefined,
              () => undefined,
            );
            pendingProviderCalls.add(tracked);
            void tracked.then(() => pendingProviderCalls.delete(tracked));
            return invocation;
          },
        ]),
      ),
    ]),
  );

  try {
    // Inject destructured globals, provider namespaces, and the shielded console proxy
    const value = await execution.program({
      ...execution.globals,
      ...providers,
      console: makeCapturedConsole(logs),
    });
    // Let any remaining unawaited provider calls resolve before signaling completion
    await Promise.all([...pendingProviderCalls]);
    return { ok: true, value, logs };
  } catch (cause) {
    // Keep isolate alive until late-running background tools settle, then bubble up the error
    await Promise.all([...pendingProviderCalls]);
    return { ok: false, error: serializeSandboxError(cause), logs };
  }
};

/**
 * Creates a shielded, virtual console object that overrides the global console.
 *
 * ### Rationale:
 * If the sandbox processes were to write directly to standard out (`console.log`), they would
 * corrupt the framed I/O streaming protocol (e.g. JSON-RPC frames over stdio) that the host
 * relies on to communicate.
 *
 * To solve this, this function intercepts all log invocations, intercepts the raw arguments, and
 * serializes them into structured, transport-neutral JSON data logs that are accumulated privately
 * and returned as part of the sandbox's final completion payload.
 */
const makeCapturedConsole = (
  logs: Array<CapturedLog>,
): Record<LogLevel, (...args: ReadonlyArray<unknown>) => void> =>
  Object.fromEntries(
    logLevels.map((level) => [
      level,
      (...args: ReadonlyArray<unknown>) => {
        logs.push({
          level,
          args: args.map(toJsonSafe),
          message: args.map(formatLogArg).join(" "),
        });
      },
    ]),
  ) as Record<LogLevel, (...args: ReadonlyArray<unknown>) => void>;

/**
 * Standardizes an arbitrary thrown VM exception into a flat, serializable representation.
 *
 * Thrown exceptions can be native `Error` objects, custom objects, or primitive types (strings, etc.).
 * To guarantee they can be safely sent over any transport (such as Worker RPC or stdio), this
 * method extracts critical details (`name`, `message`, `stack`, and optional system/lib `code` fields)
 * and normalizes anything else into a standard message envelope. This protects the host against
 * deserialization failure if the sandbox throws a non-extensible or circular-referencing exception.
 */
const serializeSandboxError = (cause: unknown): SerializedSandboxError => {
  if (cause instanceof Error) {
    const code = (cause as Error & { readonly code?: string }).code;
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
      ...(code === undefined ? {} : { code }),
    };
  }
  return { message: String(cause) };
};

/**
 * Materializes a rich JavaScript `Error` object inside the sandbox from a serialized DTO.
 *
 * When a trusted host-side tool fails, its exception is returned over the transport as a DTO.
 * This function recreates a proper JS `Error` instance inside the sandbox, fully restoring
 * its properties (such as stack trace, name, and any platform codes) so that standard try/catch
 * logic within user programs can naturally inspect stack traces, evaluate error patterns, or match
 * specific custom runtime errors.
 */
const deserializeSandboxError = (error: SerializedSandboxError): Error => {
  const result = new Error(error.message);
  if (error.name !== undefined) result.name = error.name;
  if (error.stack !== undefined) result.stack = error.stack;
  if (error.code !== undefined) {
    (result as Error & { code?: string }).code = error.code;
  }
  return result;
};

/**
 * Formats a single log argument into a clean, human-readable string.
 *
 * Handles native string values directly, displays full error stack traces (defaulting to the
 * name and message if a stack trace was never generated), and serializes complex data structures
 * into standard JSON. If the target contains circular references or triggers a serialization crash,
 * it safely falls back to standard string conversion (`String(value)`).
 */
const formatLogArg = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Recursively normalizes an input argument into a guaranteed JSON-safe representation.
 *
 * This utility isolates transport operations from potential serialization crashes caused by non-serializable
 * fields (e.g. native symbols, functions, BigInt values, or deep circular references) in log inputs.
 * It also serializes `Error` objects fully (retaining name, message, and stack), since native
 * `JSON.stringify` ignores non-enumerable properties of built-in errors.
 */
const toJsonSafe = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
};
