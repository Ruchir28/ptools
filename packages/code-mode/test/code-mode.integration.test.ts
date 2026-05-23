import { fileURLToPath } from "node:url";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Effect, Either, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CodeMode, makeCodeModeLive } from "../src/index.js";
import { CodeModeExecuteError } from "../src/errors.js";

describe("CodeMode stdio MCP integration", () => {
  it("discovers and executes MCP-backed provider calls through the local executor", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
        import.meta.url,
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const codeMode = yield* CodeMode;
        const providerResult = yield* codeMode.searchProviders();
        const echoContext = yield* codeMode.search({ query: "echo" });
        const echoSchema = yield* codeMode.toolSchema({
          toolIds: ["fixture.echo"],
        });
        const echoRun = yield* codeMode.execute({
          code: `async () => {
            console.log("calling echo");
            return await fixture.echo({ text: "hello from code mode" });
          }`,
        });
        const addRun = yield* codeMode.execute({
          code: `async () => {
            return await fixture.add({ a: 2, b: 3 });
          }`,
        });
        const caughtProviderError = yield* codeMode.execute({
          code: `async () => {
            try {
              await fixture.add({ a: "bad", b: 3 });
            } catch (error) {
              return {
                name: error.name,
                message: error.message,
              };
            }
          }`,
        });
        const uncaughtProviderError = yield* Effect.either(
          codeMode.execute({
            code: `async () => {
              return await fixture.add({ a: "bad", b: 3 });
            }`,
          }),
        );

        return {
          providerResult,
          echoContext,
          echoSchema,
          echoRun,
          addRun,
          caughtProviderError,
          uncaughtProviderError,
        };
      }).pipe(Effect.provide(makeIntegrationLive(fixturePath))),
    );

    expect(
      result.providerResult.providers.map((item) => item.provider),
    ).toEqual(["fixture"]);
    expect(toToolKeys(result.echoContext)).toEqual(["fixture.echo"]);
    expect(result.providerResult).not.toHaveProperty("declarations");
    expect(result.echoSchema.tools[0]).not.toHaveProperty("declaration");
    expect(result.echoSchema.declarationsByServer[0]?.declaration).toContain(
      "declare namespace fixture",
    );
    expect(result.echoRun.value).toEqual({ text: "hello from code mode" });
    expect(result.echoRun.logs[0]?.message).toBe("calling echo");
    expect(result.addRun.value).toEqual({ sum: 5 });
    expect(result.caughtProviderError.value).toEqual(
      expect.objectContaining({
        name: "Error",
      }),
    );
    expect(Either.isLeft(result.uncaughtProviderError)).toBe(true);

    if (Either.isLeft(result.uncaughtProviderError)) {
      expect(result.uncaughtProviderError.left).toBeInstanceOf(
        CodeModeExecuteError,
      );
    }
  });
});

const makeIntegrationLive = (fixturePath: string) =>
  makeCodeModeLive().pipe(
    Layer.provide(
      Layer.merge(
        makeMcpRegistryLive({
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx", fixturePath],
          },
        }),
        makeLocalSandboxExecutorLive(),
      ),
    ),
  );

const toToolKeys = (context: {
  readonly actions: ReadonlyArray<{ readonly toolId: string }>;
}) => context.actions.map((action) => action.toolId);
