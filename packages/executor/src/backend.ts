/**
 * Shared adapter from prepared executor requests to a host sandbox runtime.
 *
 * `ExecutorBackend` is the lower-level capability consumed by
 * `CodeExecutorLayer`. It does not represent Deno, Cloudflare, E2B, or any
 * other platform. `ExecutorBackendLayer` adapts a prepared request to the
 * required `SandboxRuntime` capability.
 *
 * This split keeps request normalization, provider-call semantics, result
 * decoding, and backend adaptation shared, while only sandbox construction and
 * communication differ per host:
 *
 *   - `@ptools/host-node`: a restricted Deno subprocess over framed stdio.
 *   - the Cloudflare host later: a Dynamic Worker / RpcTarget bridge.
 *
 * Composition contract:
 *
 *   CodeExecutorLayer.pipe(
 *     Layer.provide(
 *       ExecutorBackendLayer.pipe(Layer.provide(mySandboxRuntimeLayer)),
 *     ),
 *   )
 *
 * A platform layer therefore cannot be accidentally omitted: building the
 * adapter requires `SandboxRuntime` in the Effect environment. `CodeMode`
 * itself still sees only `CodeExecutor`.
 */
import { Context, Effect, Layer } from "effect";
import type { ExecutorError } from "./errors.js";
import type { SandboxCompletion } from "./schema.js";
import type { PreparedExecuteRequest } from "./types.js";
import { invokeProviderCall } from "./execution.js";
import { SandboxRuntime, SandboxRuntimeExecution } from "./runtime.js";

export class ExecutorBackend extends Context.Tag("@ptools/ExecutorBackend")<
  ExecutorBackend,
  {
    /**
     * Run a prepared request on this host and return the raw sandbox
     * completion envelope. The envelope is interpreted by the shared
     * `decodeSandboxCompletion` in `execution.ts`.
     */
    readonly executePrepared: (
      request: PreparedExecuteRequest,
    ) => Effect.Effect<SandboxCompletion, ExecutorError>;
  }
>() {}

/**
 * Host-neutral `ExecutorBackend` implementation requiring a concrete
 * `SandboxRuntime` layer.
 *
 * This is the only place that splits a prepared request into serializable
 * sandbox payload and trusted provider callback. Platform runtimes receive no
 * MCP registry and do not reproduce provider dispatch rules.
 */
export const ExecutorBackendLayer: Layer.Layer<
  ExecutorBackend,
  never,
  SandboxRuntime
> = Layer.effect(
  ExecutorBackend,
  Effect.gen(function* () {
    const runtime = yield* SandboxRuntime;

    return {
      executePrepared: (request: PreparedExecuteRequest) =>
        runtime.execute(
          new SandboxRuntimeExecution({
            payload: {
              code: request.code,
              globals: request.globals,
              providers: request.providerManifests,
            },
            timeoutMs: request.timeoutMs,
            handleProviderCall: (call) =>
              invokeProviderCall(request.providers, call),
          }),
        ),
    };
  }),
);
