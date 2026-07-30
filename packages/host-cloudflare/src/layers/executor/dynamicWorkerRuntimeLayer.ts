/**
 * @file Effect layer that implements `SandboxRuntime` with Dynamic Workers.
 *
 * This is the trusted host-side executor runtime. `ExecutorBackendLayer` calls
 * this service with a prepared sandbox payload and provider callback. For each
 * execution, this layer builds Worker Loader code, creates run-scoped
 * `ProviderBridge` RPC targets, loads a Dynamic Worker, and calls
 * `CodeModeSandbox.runSandboxExecution(...)`.
 */
import {
  CodeExecutor,
  CodeExecutorLayer,
  ExecutorBackendLayer,
  ExecutorProtocolError,
  ExecutorTimeoutError,
  SandboxRuntime,
  type CodeExecutorLayerOptions,
  type ExecutorBackend,
  type ExecutorError,
  type SandboxCompletion,
  type SandboxProviderCallHandler,
  type SandboxProviderCallResult,
  type SandboxRuntimeExecution,
  type SerializedSandboxError,
} from "@ptools/executor";
import { Cause, Context, Duration, Effect, Exit, Layer } from "effect";
import { injectableBindingKeys } from "@ptools/executor/sandbox";
import { buildDynamicWorkerDefinition } from "./dynamicWorkerDefinition.js";
import { ProviderBridge, type ProviderBridgeCall } from "./providerBridge.js";
import {
  CodeModeObjectWorkerLoader,
  type CodeModeObjectWorkerLoaderService,
} from "./workerLoaderService.js";
import type { DynamicExecutorProviderHandles } from "./types.js";

/**
 * Cloudflare Dynamic Worker implementation of the shared sandbox runtime.
 * Each execute call loads one fixed-adapter + generated-code module package
 * and sends provider access as run-scoped Workers RPC targets.
 */
export const CloudflareDynamicWorkerSandboxRuntimeLayer: Layer.Layer<
  SandboxRuntime,
  never,
  CodeModeObjectWorkerLoader
> = Layer.effect(
  SandboxRuntime,
  Effect.gen(function* () {
    const loader = yield* CodeModeObjectWorkerLoader;

    return {
      execute: (execution: SandboxRuntimeExecution) =>
        Effect.gen(function* () {
          // Capture references from this execution fiber's already-built
          // Context; this is a lookup, not a layer rebuild. The provider-call
          // handler has no tagged service requirements (`R = never`), but
          // Workers RPC invokes it later from plain JavaScript. Retaining the
          // Context lets that new root fiber keep this execution's configured
          // loggers, tracer, and other default Context.Reference values instead
          // of silently falling back to Effect's defaults.
          const services = yield* Effect.context<never>();
          return yield* executeInDynamicWorker({
            execution,
            loader,
            services,
          });
        }),
    };
  }),
);

const cloudflareDynamicWorkerBackendLayer: Layer.Layer<
  ExecutorBackend,
  never,
  CodeModeObjectWorkerLoader
> = ExecutorBackendLayer.pipe(
  Layer.provide(CloudflareDynamicWorkerSandboxRuntimeLayer),
);

/**
 * Convenience layer that produces a fully-wired CodeExecutor using Cloudflare
 * Dynamic Workers as the concrete sandbox runtime. Durable Object runtime
 * assembly supplies CodeModeObjectWorkerLoader from the object env binding.
 */
export const CloudflareDynamicWorkerExecutorLayer = (
  options?: CodeExecutorLayerOptions,
): Layer.Layer<CodeExecutor, never, CodeModeObjectWorkerLoader> =>
  CodeExecutorLayer(options).pipe(
    Layer.provide(cloudflareDynamicWorkerBackendLayer),
  );

const executeInDynamicWorker = (options: {
  readonly execution: SandboxRuntimeExecution;
  readonly loader: CodeModeObjectWorkerLoaderService;
  readonly services: Context.Context<never>;
}): Effect.Effect<SandboxCompletion, ExecutorError> =>
  Effect.gen(function* () {
    const providerHandles = buildProviderBridges({
      providers: options.execution.payload.providers,
      handleProviderCall: options.execution.handleProviderCall,
      services: options.services,
    });

    const workerCode = yield* buildDynamicWorkerDefinition(
      options.execution.payload,
    );
    const sandbox = yield* options.loader.loadSandbox(workerCode);

    return yield* Effect.tryPromise({
      try: () =>
        sandbox.runSandboxExecution(
          {
            payload: options.execution.payload,
            bindingKeys: injectableBindingKeys(
              options.execution.payload.globals,
              options.execution.payload.providers,
            ),
          },
          providerHandles,
        ),
      catch: (cause) =>
        new ExecutorProtocolError({
          message: "Dynamic Worker RPC sandbox execution failed",
          cause,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.execution.timeoutMs),
        orElse: () =>
          Effect.fail(
            new ExecutorTimeoutError({
              timeoutMs: options.execution.timeoutMs,
            }),
          ),
      }),
    );
  });

const buildProviderBridges = (options: {
  readonly providers: SandboxRuntimeExecution["payload"]["providers"];
  readonly handleProviderCall: SandboxRuntimeExecution["handleProviderCall"];
  readonly services: Context.Context<never>;
}): DynamicExecutorProviderHandles =>
  Object.fromEntries(
    options.providers.map((provider) => [
      provider.name,
      new ProviderBridge({
        callProvider: makeProviderBridgeCall({
          providerName: provider.name,
          handleProviderCall: options.handleProviderCall,
          services: options.services,
        }),
      }),
    ]),
  );

/**
 * Bind one execution's Effect handler into the plain Workers RPC callback.
 *
 * `handleProviderCall` closes over the prepared provider map, so it requires no
 * application service tags. `runPromiseExitWith` is still intentional: it
 * preserves ambient Effect configuration across the plain-JavaScript Workers
 * RPC boundary. `runPromiseExit` would dispatch correctly but would use the
 * default logger/tracer context instead of the context captured for this run.
 */
const makeProviderBridgeCall = (options: {
  readonly providerName: string;
  readonly handleProviderCall: SandboxProviderCallHandler;
  readonly services: Context.Context<never>;
}): ProviderBridgeCall => {
  const runPromiseExit = Effect.runPromiseExitWith(options.services);

  return async (tool, input, callId): Promise<SandboxProviderCallResult> => {
    const exit = await runPromiseExit(
      options.handleProviderCall({
        callId,
        provider: options.providerName,
        tool,
        input,
      }),
    );

    return Exit.match(exit, {
      onSuccess: (result) => result,
      onFailure: (cause) => ({
        callId,
        ok: false as const,
        error: serializeCause(cause, "ProviderBridgeFailure"),
      }),
    });
  };
};

const serializeCause = (
  cause: Cause.Cause<unknown>,
  code: string,
): SerializedSandboxError => ({
  name: "ProviderBridgeFailure",
  code,
  message: Cause.pretty(cause),
});
