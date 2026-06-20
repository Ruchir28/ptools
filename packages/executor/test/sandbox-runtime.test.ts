import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  CodeExecutor,
  CodeExecutorLayer,
  ExecutorBackendLayer,
  makeExecuteRequest,
  SandboxRuntime,
} from "../src/index.js";

describe("SandboxRuntime composition", () => {
  it("adapts prepared data and trusted provider callbacks into the runtime", async () => {
    const seenPayloads: Array<unknown> = [];
    const runtimeLayer = Layer.succeed(SandboxRuntime, {
      execute: (execution) =>
        Effect.gen(function* () {
          seenPayloads.push(execution.payload);
          const providerResult = yield* execution.handleProviderCall({
            callId: "runtime-call",
            provider: "fixture",
            tool: "echo",
            input: { text: "hello" },
          });
          return {
            ok: true as const,
            value: providerResult.ok ? providerResult.value : null,
            logs: [],
            warnings: [],
          };
        }),
    });
    const executorLayer = CodeExecutorLayer().pipe(
      Layer.provide(ExecutorBackendLayer.pipe(Layer.provide(runtimeLayer))),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;
        return yield* executor.execute(
          makeExecuteRequest({
            code: "async () => fixture.echo({ text: 'hello' })",
            globals: { seed: 7 },
            providers: [
              {
                name: "fixture",
                fns: { echo: (input) => Effect.succeed(input) },
              },
            ],
          }),
        );
      }).pipe(Effect.provide(executorLayer)),
    );

    expect(seenPayloads).toEqual([
      {
        code: "async () => fixture.echo({ text: 'hello' })",
        globals: { seed: 7 },
        providers: [{ name: "fixture", tools: ["echo"] }],
      },
    ]);
    expect(result.value).toEqual({ text: "hello" });
  });
});
