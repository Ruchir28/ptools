/// <reference path="./worker-env.d.ts" />

/**
 * Local Cloudflare Code Mode end-to-end integration tests.
 *
 * The strongest cases run the complete production-shaped local path: Worker or
 * Durable Object -> HostInstanceHandler -> Code Mode -> real Dynamic Worker ->
 * ProviderBridge -> fixture MCP server. They do not use a deployed Cloudflare
 * environment or an external MCP service.
 */
import { CodeExecutor, ExecuteRequest } from "@ptools/executor";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { PUBLIC_MCP_URL } from "./support/fixtureMcpEndpoints.js";
import { CloudflareDynamicWorkerExecutorLayer } from "../src/layers/executor/dynamicWorkerRuntimeLayer.js";
import {
  CodeModeObjectWorkerLoader,
  makeCodeModeObjectWorkerLoader,
} from "../src/layers/executor/workerLoaderService.js";
import {
  authHeaders,
  configBody,
  configureHost,
  emptyConfigBody,
  handleRequest,
  uniqueHostId,
} from "./support/cloudflareWorkerTestClient.js";

describe("worker code mode", () => {
  it("serves Code Mode requests through public Worker HTTP for configured hosts", async () => {
    const hostId = uniqueHostId();

    await configureHost(hostId, emptyConfigBody());

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "search_providers" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search_providers",
          output: { providers: [], diagnostics: [] },
        },
      },
    });
  });

  it("can load a minimal Dynamic Worker through the test WorkerLoader binding", async () => {
    const worker = env.PTOOLS_EXECUTION_LOADER.load({
      compatibilityDate: "2026-05-22",
      mainModule: "entry.js",
      modules: {
        "entry.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export class Ping extends WorkerEntrypoint {
            ping() { return "pong"; }
          }
        `,
      },
    });
    const ping = worker.getEntrypoint("Ping") as unknown as {
      readonly ping: () => Promise<string>;
    };

    await expect(ping.ping()).resolves.toBe("pong");
  });

  it("runs generated code through CloudflareDynamicWorkerExecutorLayer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;
        return yield* executor.execute(
          new ExecuteRequest({
            code: `async () => 42`,
            globals: Option.none(),
            providers: Option.none(),
            timeoutMs: Option.none(),
          }),
        );
      }).pipe(
        Effect.provide(
          CloudflareDynamicWorkerExecutorLayer().pipe(
            Layer.provide(
              Layer.succeed(
                CodeModeObjectWorkerLoader,
                makeCodeModeObjectWorkerLoader(env.PTOOLS_EXECUTION_LOADER),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result.value).toBe(42);
  });

  it("runs provider calls through the real Dynamic Worker ProviderBridge", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;
        return yield* executor.execute(
          new ExecuteRequest({
            code: `async () => fixture.echo({ text: "hello provider" })`,
            globals: Option.none(),
            providers: Option.some([
              {
                name: "fixture",
                fns: {
                  echo: (input) => Effect.succeed(input),
                },
              },
            ]),
            timeoutMs: Option.none(),
          }),
        );
      }).pipe(
        Effect.provide(
          CloudflareDynamicWorkerExecutorLayer().pipe(
            Layer.provide(
              Layer.succeed(
                CodeModeObjectWorkerLoader,
                makeCodeModeObjectWorkerLoader(env.PTOOLS_EXECUTION_LOADER),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result.value).toEqual({ text: "hello provider" });
  });

  it("runs multi-tool generated code through the real Dynamic Worker ProviderBridge", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* CodeExecutor;
        return yield* executor.execute(
          new ExecuteRequest({
            code: `async () => {
              const echo = await fixture.echo({ text: "hello dynamic worker" });
              const add = await fixture.add({ a: 2, b: 3 });

              return { echo, add };
            }`,
            globals: Option.none(),
            providers: Option.some([
              {
                name: "fixture",
                fns: {
                  echo: (input) => Effect.succeed(input),
                  add: () => Effect.succeed({ sum: 5 }),
                },
              },
            ]),
            timeoutMs: Option.none(),
          }),
        );
      }).pipe(
        Effect.provide(
          CloudflareDynamicWorkerExecutorLayer().pipe(
            Layer.provide(
              Layer.succeed(
                CodeModeObjectWorkerLoader,
                makeCodeModeObjectWorkerLoader(env.PTOOLS_EXECUTION_LOADER),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result.value).toEqual({
      echo: { text: "hello dynamic worker" },
      add: { sum: 5 },
    });
  });

  it("executes MCP tools through public Worker HTTP and a real Dynamic Worker", async () => {
    const hostId = uniqueHostId();

    await configureHost(hostId, configBody({ url: PUBLIC_MCP_URL }));

    const refresh = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "refresh" }),
    });
    expect(refresh.status).toBe(200);
    await expect(refresh.json()).resolves.toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "refresh",
          output: { refreshed: true },
        },
      },
    });

    const search = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        operation: "search",
        input: { query: "echo", limit: 1 },
      }),
    });
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: {
            actions: [
              {
                toolId: "example.echo",
                provider: "example",
                action: "echo",
              },
            ],
            diagnostics: [],
          },
        },
      },
    });

    const execute = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        operation: "execute",
        input: {
          code: `async () => {
            const echo = await example.echo({ text: "hello dynamic worker" });
            const add = await example.add({ a: 2, b: 3 });

            return { echo, add };
          }`,
        },
      }),
    });
    expect(execute.status).toBe(200);
    await expect(execute.json()).resolves.toEqual({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "execute",
          output: {
            value: {
              echo: { text: "hello dynamic worker" },
              add: { sum: 5 },
            },
            logs: [],
            warnings: [],
          },
        },
      },
    });
  });
});
