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
  type SandboxRuntimeExecution,
} from "@ptools/executor";
import { Duration, Effect, Layer, Runtime } from "effect";
import { injectableBindingKeys } from "@ptools/executor/sandbox";
import { buildDynamicWorkerDefinition } from "./dynamicWorkerDefinition.js";
import { ProviderBridge } from "./providerBridge.js";
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

    // Capture the currently composed Effect runtime as a plain JS value. This
    // does not create a new runtime. ProviderBridge is called later by
    // Cloudflare Workers RPC outside `Effect.gen`, so it needs this handle to
    // re-enter the same host runtime with Runtime.runPromiseExit(...).
    const runtime = yield* Effect.runtime<never>();

    return {
      execute: (execution: SandboxRuntimeExecution) =>
        executeInDynamicWorker({ execution, loader, runtime }),
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
  readonly runtime: Runtime.Runtime<never>;
}): Effect.Effect<SandboxCompletion, ExecutorError> =>
  Effect.gen(function* () {
    const providerHandles = buildProviderBridges({
      providers: options.execution.payload.providers,
      handleProviderCall: options.execution.handleProviderCall,
      runtime: options.runtime,
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
      Effect.timeoutFail({
        duration: Duration.millis(options.execution.timeoutMs),
        onTimeout: () =>
          new ExecutorTimeoutError({ timeoutMs: options.execution.timeoutMs }),
      }),
    );
  });

const buildProviderBridges = (options: {
  readonly providers: SandboxRuntimeExecution["payload"]["providers"];
  readonly handleProviderCall: SandboxRuntimeExecution["handleProviderCall"];
  readonly runtime: Runtime.Runtime<never>;
}): DynamicExecutorProviderHandles =>
  Object.fromEntries(
    options.providers.map((provider) => [
      provider.name,
      new ProviderBridge({
        providerName: provider.name,
        handleProviderCall: options.handleProviderCall,
        runtime: options.runtime,
      }),
    ]),
  );
