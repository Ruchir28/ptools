import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CodeExecutor,
  ExecutorProtocolError,
  ExecutorRuntimeError,
  ExecutorTimeoutError,
  InvalidExecutorCode,
  makeLocalSandboxExecutorLive,
} from "../src/index.js";
import type { ExecutorError } from "../src/errors.js";
import { RpcHost, type ProviderMap } from "../src/RpcHost.js";
import type { ExecuteRequest, ExecuteResult } from "../src/types.js";

const execute = (
  request: ExecuteRequest,
): Effect.Effect<ExecuteResult, ExecutorError, CodeExecutor> =>
  Effect.gen(function* () {
    const executor = yield* CodeExecutor;
    return yield* executor.execute(request);
  });

const runWithExecutor = <A, E>(
  effect: Effect.Effect<A, E, CodeExecutor>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(makeLocalSandboxExecutorLive())));

const fixtureProviders = (
  fns: ProviderMap extends ReadonlyMap<string, infer Fns> ? Fns : never,
) => [{ name: "fixture", fns }];

describe("LocalSandboxExecutor", () => {
  it("executes an async function expression with serializable globals", async () => {
    const result = await runWithExecutor(
      execute({
        code: "async () => ({ doubled: value * 2 })",
        globals: { value: 21 },
      }),
    );

    expect(result.value).toEqual({ doubled: 42 });
    expect(result.logs).toEqual([]);
  });

  it("captures console logs by level", async () => {
    const result = await runWithExecutor(
      execute({
        code: `async () => {
          console.log("hello", { count: 1 });
          console.warn("careful");
          console.error(new Error("boom"));

          return "done";
        }`,
      }),
    );

    expect(result.value).toBe("done");
    expect(result.logs.map((log) => log.level)).toEqual([
      "log",
      "warn",
      "error",
    ]);
    expect(result.logs[0]?.message).toBe('hello {"count":1}');
    expect(result.logs[1]?.message).toBe("careful");
    expect(result.logs[2]?.message).toContain("Error: boom");
  });

  it("exposes provider functions as top-level namespace objects", async () => {
    const calls: Array<unknown> = [];
    const result = await runWithExecutor(
      execute({
        code: `async () => {
          return await fixture.add({ a: 2, b: 3 });
        }`,
        providers: fixtureProviders({
          add: (input) => {
            calls.push(input);
            const args = input as {
              readonly a: number;
              readonly b: number;
            };

            return Effect.succeed({ sum: args.a + args.b });
          },
        }),
      }),
    );

    expect(calls).toEqual([{ a: 2, b: 3 }]);
    expect(result.value).toEqual({ sum: 5 });
  });

  it("uses one scoped executor host for sequential executions", async () => {
    const values = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;
        const first = yield* executor.execute({
          code: "async () => fixture.value({ run: 1 })",
          providers: fixtureProviders({
            value: (input) => Effect.succeed(input),
          }),
        });
        const second = yield* executor.execute({
          code: "async () => fixture.value({ run: 2 })",
          providers: fixtureProviders({
            value: (input) => Effect.succeed(input),
          }),
        });

        return [first.value, second.value] as const;
      }),
    );

    expect(values).toEqual([{ run: 1 }, { run: 2 }]);
  });

  it("routes concurrent executions to the correct run providers", async () => {
    const values = await runWithExecutor(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;

        return yield* Effect.all(
          [
            executor.execute({
              code: "async () => fixture.tag({ input: 'a' })",
              providers: fixtureProviders({
                tag: (input) => Effect.succeed({ owner: "a", input }),
              }),
            }),
            executor.execute({
              code: "async () => fixture.tag({ input: 'b' })",
              providers: fixtureProviders({
                tag: (input) => Effect.succeed({ owner: "b", input }),
              }),
            }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    expect(values.map((result) => result.value)).toEqual([
      { owner: "a", input: { input: "a" } },
      { owner: "b", input: { input: "b" } },
    ]);
  });

  it("propagates provider errors back into sandbox code", async () => {
    const result = await runWithExecutor(
      execute({
        code: `async () => {
          try {
            await fixture.fail({ ok: false });
          } catch (error) {
            return {
              name: error.name,
              message: error.message,
            };
          }
        }`,
        providers: fixtureProviders({
          fail: () => {
            return Effect.fail(new Error("fixture failure"));
          },
        }),
      }),
    );

    expect(result.value).toEqual({
      name: "Error",
      message: "fixture failure",
    });
  });

  it("fails when code does not evaluate to a function", async () => {
    const result = await runWithExecutor(
      Effect.either(
        execute({
          code: "42",
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidExecutorCode);
      if (result.left._tag === "InvalidExecutorCode") {
        expect(result.left.error.message).toContain(
          "Executor code must evaluate to a function expression.",
        );
        expect(result.left.error.message).toContain("async () =>");
      }
    }
  });

  it("fails before sandbox start for invalid provider names", async () => {
    const result = await runWithExecutor(
      Effect.either(
        execute({
          code: "async () => null",
          providers: [
            {
              name: "not-valid",
              fns: {
                call: () => Effect.succeed(null),
              },
            },
          ],
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ExecutorProtocolError);
      expect(result.left.message).toBe(
        "Invalid provider identifier: not-valid",
      );
    }
  });

  it("fails before sandbox start when a global collides with a provider", async () => {
    const result = await runWithExecutor(
      Effect.either(
        execute({
          code: "async () => null",
          globals: { fixture: { value: 1 } },
          providers: fixtureProviders({
            call: () => Effect.succeed(null),
          }),
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ExecutorProtocolError);
      expect(result.left.message).toBe(
        "Global name collides with provider name: fixture",
      );
    }
  });

  it("fails when sandbox code throws without catching", async () => {
    const result = await runWithExecutor(
      Effect.either(
        execute({
          code: `async () => {
            throw new Error("uncaught");
          }`,
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ExecutorRuntimeError);
      if (result.left._tag === "ExecutorRuntimeError") {
        expect(result.left.error.message).toBe("uncaught");
      }
    }
  });

  it("times out and cleans up long-running execution", async () => {
    const result = await runWithExecutor(
      Effect.either(
        execute({
          code: `async () => {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
          }`,
          timeoutMs: 1_000,
        }),
      ),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ExecutorTimeoutError);
      if (result.left._tag === "ExecutorTimeoutError") {
        expect(result.left.timeoutMs).toBe(1_000);
      }
    }
  });
});

describe("RpcHost", () => {
  it("rejects the wrong token for a valid run", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* RpcHost.make();
          const registeredRun = host.registerRun({
            runId: "run-token",
            token: "correct-token",
            providers: makeProviderMap(),
            complete: vi.fn(),
            fail: vi.fn(),
          });
          const response = yield* Effect.promise(() =>
            postJson(
              `${registeredRun.rpcUrl}/call`,
              { provider: "fixture", tool: "echo", input: "hello" },
              "wrong-token",
            ),
          );

          return response.status;
        }),
      ),
    );

    expect(status).toBe(401);
  });

  it("rejects an unknown run id", async () => {
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* RpcHost.make();
          const registeredRun = host.registerRun({
            runId: "run-known",
            token: "token",
            providers: makeProviderMap(),
            complete: vi.fn(),
            fail: vi.fn(),
          });
          registeredRun.unregister();
          const response = yield* Effect.promise(() =>
            postJson(
              `${registeredRun.rpcUrl}/call`,
              { provider: "fixture", tool: "echo", input: "hello" },
              "token",
            ),
          );

          return response.status;
        }),
      ),
    );

    expect(status).toBe(404);
  });

  it("removes completed runs from the active run map", async () => {
    const activeCounts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* RpcHost.make();
          const registeredRun = host.registerRun({
            runId: "run-complete",
            token: "token",
            providers: makeProviderMap(),
            complete: vi.fn(),
            fail: vi.fn(),
          });
          const before = host.activeRunCount();
          const response = yield* Effect.promise(() =>
            postJson(
              `${registeredRun.rpcUrl}/complete`,
              { ok: true, value: "done", logs: [] },
              "token",
            ),
          );
          const after = host.activeRunCount();

          return {
            before,
            status: response.status,
            after,
          };
        }),
      ),
    );

    expect(activeCounts).toEqual({
      before: 1,
      status: 200,
      after: 0,
    });
  });

  it("closes the shared server when its scope closes", async () => {
    let callUrl = "";

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* RpcHost.make();
          const registeredRun = host.registerRun({
            runId: "run-close",
            token: "token",
            providers: makeProviderMap(),
            complete: vi.fn(),
            fail: vi.fn(),
          });
          callUrl = `${registeredRun.rpcUrl}/call`;
        }),
      ),
    );

    await expect(
      postJson(
        callUrl,
        { provider: "fixture", tool: "echo", input: "hello" },
        "token",
      ),
    ).rejects.toThrow();
  });
});

const makeProviderMap = (): ProviderMap =>
  new Map([
    [
      "fixture",
      {
        echo: (input) => Effect.succeed(input),
      },
    ],
  ]);

const postJson = async (
  url: string,
  body: unknown,
  token: string,
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
