import { Context, Effect, Layer, Option } from "effect";
import { ExecutorBackend } from "./backend.js";
import type { ExecutorError } from "./errors.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";
import {
  decodeSandboxCompleteResult,
  prepareExecuteRequest,
} from "./semantic.js";

/**
 * The stable semantic execution service consumed by Code Mode.
 *
 * "Run this generated code request and return an `ExecuteResult`." This is the
 * only executor capability Code Mode depends on; it never sees the lower-level
 * `ExecutorBackend`. The shared implementation that wires this service to a
 * host backend is `CodeExecutorLayer` below.
 */
export class CodeExecutor extends Context.Tag("@ptools/CodeExecutor")<
  CodeExecutor,
  {
    readonly execute: (
      request: ExecuteRequest,
    ) => Effect.Effect<ExecuteResult, ExecutorError>;
  }
>() {}

/**
 * Effect-side options for {@link CodeExecutorLayer}.
 *
 * Optional configuration uses `Option` rather than an optional property, per
 * the internal-config convention: public/JSON callers may keep native optional
 * properties at their own boundary, but must convert to `Option` before
 * entering this layer.
 */
export interface CodeExecutorLayerOptions {
  readonly defaultTimeoutMs: Option.Option<number>;
}

export const defaultCodeExecutorLayerOptions: CodeExecutorLayerOptions = {
  defaultTimeoutMs: Option.none(),
};

/**
 * Shared implementation of {@link CodeExecutor} that composes host-neutral
 * semantics with a host-provided {@link ExecutorBackend}.
 *
 * Request flow inside `execute`:
 *
 *   prepareExecuteRequest(request, options)
 *     -> ExecutorBackend.executePrepared(prepared)
 *       -> decodeSandboxCompleteResult(envelope)
 *
 * Dependencies: requires an `ExecutorBackend` in the environment and produces
 * a `CodeExecutor`. A host assembles the full capability by providing its own
 * backend layer:
 *
 *   CodeExecutorLayer({ defaultTimeoutMs: Option.some(15_000) }).pipe(
 *     Layer.provide(myBackendLayer),
 *   );
 *
 * When `defaultTimeoutMs` is `Option.none()` and the request omits a timeout,
 * `prepareExecuteRequest` falls back to its built-in 30s default.
 */
export const CodeExecutorLayer = (
  options: CodeExecutorLayerOptions = defaultCodeExecutorLayerOptions,
): Layer.Layer<CodeExecutor, never, ExecutorBackend> =>
  Layer.effect(
    CodeExecutor,
    Effect.gen(function* () {
      const backend = yield* ExecutorBackend;

      return {
        execute: (request: ExecuteRequest) =>
          prepareExecuteRequest(request, {
            defaultTimeoutMs: options.defaultTimeoutMs,
          }).pipe(
            Effect.flatMap((prepared) => backend.executePrepared(prepared)),
            Effect.flatMap(decodeSandboxCompleteResult),
          ),
      };
    }),
  );
