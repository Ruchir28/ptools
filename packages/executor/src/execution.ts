/**
 * Host-neutral execution rules shared by every backend and sandbox runtime.
 *
 * These functions are plain functions returning `Effect`s, not layers and not a
 * service. The layers live beside their service boundaries: `CodeExecutorLayer`
 * in `./executor.ts`, and the adapter from `ExecutorBackend` to the host's
 * `SandboxRuntime` in `./backend.ts`. Every platform routes through these rules
 * so request normalization, provider-call dispatch, and result interpretation
 * stay identical across hosts.
 *
 * Execution flow:
 *
 *   prepareExecuteRequest(request, options)   normalize + validate -> PreparedExecuteRequest
 *   ExecutorBackend.executePrepared(prepared) adapts to SandboxRuntime -> SandboxCompletion
 *   decodeSandboxCompletion(envelope)         interpret -> ExecuteResult | ExecutorError
 *
 * Provider-call flow:
 *
 *   sandbox code asks for { provider, tool, input }
 *   host transport decodes SandboxProviderCall
 *   invokeProviderCall(providers, call) invokes the captured callback
 *   host transport returns SandboxProviderCallResult to sandbox code
 *
 * Notice the error-channel shape: provider-call failures are data envelopes
 * because they must cross a host transport back into sandbox JavaScript. Final
 * sandbox-completion failures are converted back into the Effect error channel
 * by `decodeSandboxCompletion`.
 */
import { Cause, Effect, Option } from "effect";
import {
  ExecutorProtocolError,
  ExecutorRuntimeError,
  InvalidExecutorCode,
  type ExecutorError,
} from "./errors.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  ExecutorProviderHandler,
  ExecutorProviders,
  PreparedExecuteRequest,
  SandboxGlobals,
} from "./types.js";
import { PreparedExecuteRequest as PreparedExecuteRequestValue } from "./types.js";
import type {
  SandboxCompletion,
  SandboxProviderCall,
  SandboxProviderCallResult,
  SerializedSandboxError,
} from "./schema.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBAL_NAMES = new Set(["console", "globalThis"]);

export interface PrepareExecuteRequestOptions {
  readonly defaultTimeoutMs: Option.Option<number>;
}

export const defaultPrepareExecuteRequestOptions: PrepareExecuteRequestOptions =
  {
    defaultTimeoutMs: Option.none(),
  };

/**
 * Normalize and validate an {@link ExecuteRequest} into a host-ready
 * {@link PreparedExecuteRequest}.
 *
 * Owns the host-neutral preparation rules shared by every backend:
 * filling the default timeout (request -> layer default -> built-in 30s),
 * normalizing absent `globals`/`providers` to empty, validating global and
 * provider/tool identifiers (and rejecting reserved names `console` /
 * `globalThis`), detecting duplicate providers and provider/global name
 * collisions, and deriving the pure `SandboxProviderManifest` per provider.
 *
 * It does NOT validate MCP tool input schemas (that belongs to Code Mode /
 * MCP registry) and does NOT call the backend. The returned value is the
 * exact input a host `ExecutorBackend.executePrepared` consumes.
 */
export const prepareExecuteRequest = (
  request: ExecuteRequest,
  options: PrepareExecuteRequestOptions = defaultPrepareExecuteRequestOptions,
): Effect.Effect<PreparedExecuteRequest, ExecutorProtocolError> =>
  Effect.try({
    try: () => {
      const globals = Option.getOrElse(request.globals, () => ({}));
      const providers = Option.getOrElse(request.providers, () => []);
      const timeoutMs = Option.getOrElse(request.timeoutMs, () =>
        Option.getOrElse(options.defaultTimeoutMs, () => DEFAULT_TIMEOUT_MS),
      );

      validateGlobals(globals, providers);

      return new PreparedExecuteRequestValue({
        code: request.code,
        timeoutMs,
        globals,
        providers: validateProviders(providers),
        providerManifests: providers.map((provider) => ({
          name: provider.name,
          tools: Object.keys(provider.fns),
        })),
      });
    },
    catch: (cause) =>
      cause instanceof ExecutorProtocolError
        ? cause
        : new ExecutorProtocolError({
            message: "Failed to prepare executor request",
            cause,
          }),
  });

/**
 * Shared provider-call dispatch used by every host transport (Deno stdio,
 * Workers RPC, future in-memory).
 *
 * Given the host-side callback table (`providers`, built by Code Mode and
 * closing over the MCP registry) and a sandbox-originating `SandboxProviderCall`,
 * this looks up the provider + tool and invokes the handler. Every outcome is
 * returned as a structured {@link SandboxProviderCallResult} envelope (error
 * channel is `never`) so it can cross host transport back to the sandbox:
 *
 *   - success                                 -> { ok: true, value }
 *   - unknown provider or tool                -> { ok: false, error: ProviderToolNotFound }
 *   - handler failure/defect/interruption      -> { ok: false, error: serializeCause(_, "ProviderToolError") }
 *
 * The function is shared; the transport that carries `SandboxProviderCall` to
 * it is host-owned.
 */
export const invokeProviderCall = (
  providers: ExecutorProviders,
  call: SandboxProviderCall,
): Effect.Effect<SandboxProviderCallResult> =>
  findProviderHandler(providers, call).pipe(
    Option.match({
      onNone: () => Effect.succeed(providerToolNotFound(call)),
      onSome: (handler) =>
        runProviderHandler(handler, call.input).pipe(
          Effect.matchCause({
            onFailure: (cause) => ({
              ok: false,
              callId: call.callId,
              error: serializeCause(cause, "ProviderToolError"),
            }),
            onSuccess: (value) => ({
              ok: true,
              callId: call.callId,
              value,
            }),
          }),
        ),
    }),
  );

/**
 * Interpret a sandbox completion envelope into an {@link ExecuteResult} or a
 * shared {@link ExecutorError}.
 *
 * Both Node and Cloudflare backends return the same `SandboxCompletion`
 * envelope and share this interpretation: success -> `ExecuteResult`; failure
 * with `error.code === "InvalidExecutorCode"` -> `InvalidExecutorCode`; any
 * other failure -> `ExecutorRuntimeError`.
 */
export const decodeSandboxCompletion = (
  result: SandboxCompletion,
): Effect.Effect<ExecuteResult, ExecutorError> =>
  result.ok
    ? Effect.succeed(toExecuteResult(result))
    : Effect.fail(toSandboxCompletionError(result.error));

/**
 * Flatten an Effect `Cause` into the transport-neutral
 * {@link SerializedSandboxError} shape used in provider-call and completion
 * envelopes. Falls back to a stringified cause for defects/interruptions.
 */
export const serializeCause = (
  cause: Cause.Cause<unknown>,
  code?: string,
): SerializedSandboxError =>
  Cause.failureOption(cause).pipe(
    Option.match({
      onNone: () => serializeUnknownError(new Error(Cause.pretty(cause)), code),
      onSome: (failure) => serializeUnknownError(failure, code),
    }),
  );

/**
 * Serialize a thrown/unknown value into a {@link SerializedSandboxError}.
 * Preserves `name`/`message`/`stack` for `Error` instances and stringifies
 * anything else.
 */
export const serializeUnknownError = (
  cause: unknown,
  code?: string,
): SerializedSandboxError => {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
      ...(code === undefined ? {} : { code }),
    };
  }

  return {
    message: String(cause),
    ...(code === undefined ? {} : { code }),
  };
};

const validateProviders = (providers: ExecutorProviders): ExecutorProviders => {
  const providerNames = new Set<string>();

  for (const provider of providers) {
    validateIdentifier(provider.name, "provider");

    if (providerNames.has(provider.name)) {
      throw new ExecutorProtocolError({
        message: `Duplicate provider name: ${provider.name}`,
      });
    }

    providerNames.add(provider.name);

    for (const toolName of Object.keys(provider.fns)) {
      validateIdentifier(toolName, `tool in provider ${provider.name}`);
    }
  }

  return providers;
};

const validateGlobals = (
  globals: SandboxGlobals,
  providers: ExecutorProviders,
): void => {
  const providerNames = new Set(providers.map((provider) => provider.name));

  for (const name of Object.keys(globals)) {
    validateIdentifier(name, "global");

    if (providerNames.has(name)) {
      throw new ExecutorProtocolError({
        message: `Global name collides with provider name: ${name}`,
      });
    }
  }
};

const validateIdentifier = (name: string, scope: string): void => {
  if (!VALID_IDENTIFIER.test(name) || RESERVED_GLOBAL_NAMES.has(name)) {
    throw new ExecutorProtocolError({
      message: `Invalid ${scope} identifier: ${name}`,
    });
  }
};

const findProviderHandler = (
  providers: ExecutorProviders,
  call: SandboxProviderCall,
): Option.Option<ExecutorProviderHandler> =>
  Option.fromNullable(
    providers.find((provider) => provider.name === call.provider)?.fns[
      call.tool
    ],
  );

const providerToolNotFound = (
  call: SandboxProviderCall,
): SandboxProviderCallResult => ({
  ok: false,
  callId: call.callId,
  error: {
    name: "ProviderToolNotFound",
    message: `Provider tool not found: ${call.provider}.${call.tool}`,
    code: "ProviderToolNotFound",
  },
});

const runProviderHandler = (
  handler: ExecutorProviderHandler,
  input: unknown,
): Effect.Effect<unknown, unknown> => Effect.suspend(() => handler(input));

const toExecuteResult = (
  result: Extract<SandboxCompletion, { readonly ok: true }>,
): ExecuteResult => ({
  value: result.value,
  logs: result.logs,
});

const toSandboxCompletionError = (
  error: SerializedSandboxError,
): InvalidExecutorCode | ExecutorRuntimeError =>
  error.code === "InvalidExecutorCode"
    ? new InvalidExecutorCode({ error })
    : new ExecutorRuntimeError({ error });
