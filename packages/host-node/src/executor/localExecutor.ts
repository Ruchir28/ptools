/**
 * @file Local Sandbox Executor (Host-Side)
 *
 * This file implements the host-side orchestration for running sandboxed code locally.
 * It manages the lifecycle of restricted Deno subprocesses, handles bi-directional
 * NDJSON communication, and dispatches sandbox-originating tool calls to real host-side
 * MCP providers.
 *
 * ### Architectural Role & Security Boundary
 *
 * This file runs entirely inside the TRUSTED host environment (Node.js). It has full
 * access to the host system, environment variables, and the real MCP registry. It is
 * responsible for:
 * 1. **Process Isolation**: Spawning a heavily locked-down Deno subprocess (denying read,
 *    write, network, env, run, ffi, sys, and import permissions).
 * 2. **Verification**: Ensuring that incoming sandbox messages are valid, checking for
 *    duplicate call IDs, and verifying that the sandbox does not attempt to call tools
 *    after reporting completion.
 * 3. **Dispatching**: Routing approved tool calls from the sandbox to the real host-side
 *    provider-call handler supplied by the shared backend adapter.
 */

import {
  CodeExecutor,
  CodeExecutorLayer,
  ExecutorBackendLayer,
  ExecutorProtocolError,
  ExecutorStartError,
  ExecutorTimeoutError,
  HostToSandboxProviderResultMessage,
  SandboxRuntime,
  type ExecutorBackend,
  type ExecutorError,
  type SandboxCompletion,
  type SandboxProviderCallHandler,
  type SandboxRuntimeExecution,
  type SandboxToHostMessage,
} from "@ptools/executor";
import { Deferred, Duration, Effect, Layer, Option, Ref, Stream } from "effect";
import {
  acquireDenoSandboxProcess,
  readSandboxMessages,
  resolveDenoSandboxRuntimeConfig,
  type DenoSandboxRuntimeConfig,
  type DenoSandboxProcess,
} from "./denoSandboxProcess.js";

/**
 * Public configuration options for the local restricted-Deno sandbox executor.
 * Permission grants are intentionally absent to maintain a strict deny-all boundary.
 */
export interface DenoSandboxRuntimeOptions {
  /** Optional path to the Deno executable. Defaults to "deno" in PATH. */
  readonly denoExecutable?: string;
}

/**
 * Public convenience options for a fully assembled local executor.
 */
export interface LocalSandboxExecutorOptions extends DenoSandboxRuntimeOptions {
  /** The default execution timeout in milliseconds. Falls back to 30s if omitted. */
  readonly defaultTimeoutMs?: number;
}

/**
 * Provides the concrete host-side sandbox capability backed by restricted
 * Deno subprocesses.
 *
 * Constructing the layer verifies that a supported Deno executable exists.
 * Each `execute` call then acquires one process and scopes its teardown to that
 * execution. The shared `ExecutorBackendLayer` cannot build until this service
 * (or another platform's `SandboxRuntime`) is provided.
 */
export const DenoSandboxRuntimeLayer = (
  options?: DenoSandboxRuntimeOptions,
): Layer.Layer<SandboxRuntime, ExecutorStartError> =>
  Layer.effect(
    SandboxRuntime,
    resolveDenoSandboxRuntimeConfig(options).pipe(
      Effect.map((config) => ({
        execute: (execution: SandboxRuntimeExecution) =>
          runDenoSandbox(execution, config).pipe(Effect.scoped),
      })),
    ),
  );

const localExecutorBackendLayer = (
  options?: LocalSandboxExecutorOptions,
): Layer.Layer<ExecutorBackend, ExecutorStartError> =>
  ExecutorBackendLayer.pipe(Layer.provide(DenoSandboxRuntimeLayer(options)));

/**
 * Convenience layer that produces a fully-wired `CodeExecutor` service by composing
 * `CodeExecutorLayer`, the shared backend adapter, and the Deno runtime.
 *
 * Code Mode depends exclusively on the `CodeExecutor` tag, remaining completely
 * decoupled from the underlying Deno process mechanics.
 */
export const LocalSandboxExecutorLayer = (
  options?: LocalSandboxExecutorOptions,
): Layer.Layer<CodeExecutor, ExecutorStartError> =>
  CodeExecutorLayer({
    defaultTimeoutMs: Option.fromNullable(options?.defaultTimeoutMs),
  }).pipe(Layer.provide(localExecutorBackendLayer(options)));

interface ProtocolState {
  readonly completed: boolean;
  readonly seenCallIds: ReadonlySet<string>;
}

const runDenoSandbox = (
  execution: SandboxRuntimeExecution,
  config: DenoSandboxRuntimeConfig,
): Effect.Effect<SandboxCompletion, ExecutorError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const completion = yield* Deferred.make<
        SandboxCompletion,
        ExecutorError
      >();
      const state = yield* Ref.make<ProtocolState>({
        completed: false,
        seenCallIds: new Set(),
      });
      const sandbox = yield* acquireDenoSandboxProcess(config);

      yield* readSandboxMessages(sandbox).pipe(
        Stream.mapEffect(
          (message) =>
            handleSandboxMessage({
              message,
              handleProviderCall: execution.handleProviderCall,
              process: sandbox,
              completion,
              state,
            }),
          { concurrency: "unbounded" },
        ),
        Stream.runDrain,
        Effect.zipRight(
          Deferred.fail(
            completion,
            new ExecutorProtocolError({
              message: "Sandbox stdout closed before completion",
            }),
          ),
        ),
        Effect.catchAll((error) =>
          Deferred.fail(completion, error).pipe(Effect.asVoid),
        ),
        Effect.forkScoped,
      );

      yield* sandbox.exit.pipe(
        Effect.flatMap((exit) =>
          Deferred.fail(
            completion,
            new ExecutorProtocolError({
              message: `Deno sandbox exited before completion (${formatExit(exit.code, exit.signal)})${
                exit.stderr.length === 0 ? "" : `\nstderr:\n${exit.stderr}`
              }`,
            }),
          ),
        ),
        Effect.catchAll((error) =>
          Deferred.fail(completion, error).pipe(Effect.asVoid),
        ),
        Effect.forkScoped,
      );

      yield* sandbox.write({
        _tag: "Execute",
        payload: execution.payload,
      });

      return yield* Deferred.await(completion).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(execution.timeoutMs),
          onTimeout: () =>
            new ExecutorTimeoutError({ timeoutMs: execution.timeoutMs }),
        }),
      );
    }),
  );

const handleSandboxMessage = (options: {
  readonly message: SandboxToHostMessage;
  readonly handleProviderCall: SandboxProviderCallHandler;
  readonly process: DenoSandboxProcess;
  readonly completion: Deferred.Deferred<SandboxCompletion, ExecutorError>;
  readonly state: Ref.Ref<ProtocolState>;
}): Effect.Effect<void, ExecutorProtocolError> => {
  if (options.message._tag === "Complete") {
    return claimCompletion(options.state).pipe(
      Effect.zipRight(
        Deferred.succeed(options.completion, options.message.completion),
      ),
      Effect.asVoid,
    );
  }

  return claimCallId(options.state, options.message.call.callId).pipe(
    Effect.zipRight(options.handleProviderCall(options.message.call)),
    Effect.map((result) =>
      HostToSandboxProviderResultMessage.make({
        result,
      }),
    ),
    Effect.flatMap(options.process.write),
  );
};

const claimCallId = (
  state: Ref.Ref<ProtocolState>,
  callId: string,
): Effect.Effect<void, ExecutorProtocolError> =>
  Ref.modify(state, (current) => {
    const error = current.completed
      ? new ExecutorProtocolError({
          message: "Provider call received after completion",
        })
      : current.seenCallIds.has(callId)
        ? new ExecutorProtocolError({
            message: `Duplicate provider callId: ${callId}`,
          })
        : undefined;
    if (error !== undefined) return [Option.some(error), current] as const;
    return [
      Option.none<ExecutorProtocolError>(),
      { ...current, seenCallIds: new Set([...current.seenCallIds, callId]) },
    ] as const;
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: Effect.fail,
      }),
    ),
  );

const claimCompletion = (
  state: Ref.Ref<ProtocolState>,
): Effect.Effect<void, ExecutorProtocolError> =>
  Ref.modify(state, (current) =>
    current.completed
      ? ([
          Option.some(
            new ExecutorProtocolError({
              message: "Sandbox completed more than once",
            }),
          ),
          current,
        ] as const)
      : ([
          Option.none<ExecutorProtocolError>(),
          { ...current, completed: true },
        ] as const),
  ).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: Effect.fail,
      }),
    ),
  );

const formatExit = (
  code: number | null,
  signal: NodeJS.Signals | null,
): string =>
  signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
