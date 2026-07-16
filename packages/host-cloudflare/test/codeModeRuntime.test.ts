/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Code Mode runtime layer integration tests.
 *
 * This file builds the shared `ConfiguredHostContextLayer` with Cloudflare
 * primitives, in-memory Durable Object storage, and a recording
 * `CodeModeObjectWorkerLoader`. It is
 * meant to prove the Effect layer graph: stored config loading, request-origin
 * wiring, HTTP MCP connector/registry behavior, Code Mode search/schema
 * assembly, real declaration generation, and provider callback dispatch through
 * `ProviderBridge` into the local HTTP MCP fixture.
 *
 * The final Dynamic Worker boundary is intentionally fake here: the recording
 * loader captures the generated WorkerLoader code/payload and manually invokes
 * the provider RPC handle. It does not provision `env.PTOOLS_EXECUTION_LOADER`
 * and does not run generated JavaScript inside a real Dynamic Worker.
 *
 * Full local Cloudflare Dynamic Worker execution is covered in
 * `worker-code-mode.integration.test.ts`, which runs under the Worker/Vitest
 * pool with the Wrangler `worker_loaders` binding.
 */
import {
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeToolSchemaRequest,
} from "@ptools/code-mode-api";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import {
  CONFIGURED_HOST_CONFIG_BLOB_KEY,
  ConfiguredHostConfigBlob,
  HostSecretStorageBackend,
  HostStateStorageBackend,
  PtoolsConfig,
} from "@ptools/config";
import type { SandboxCompletion } from "@ptools/executor";
import { HostIdentityLayer, HostPublicOriginLayer } from "@ptools/host-context";
import {
  ConfiguredHostContextLayer,
  HostStableSharedStoresLayer,
  type ConfiguredHostOperationServices,
} from "@ptools/host-runtime";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_MCP_URL } from "./support/fixtureMcpEndpoints.js";
import { CloudflareDynamicWorkerSandboxRuntimeLayer } from "../src/layers/executor/dynamicWorkerRuntimeLayer.js";
import {
  CloudflareHttpMcpConnectorLayer,
  CloudflareMcpConnectorLayer,
} from "../src/layers/mcpConnector.js";
import {
  CodeModeObjectWorkerLoader,
  type CodeModeObjectWorkerLoaderService,
} from "../src/layers/executor/workerLoaderService.js";
import { makeDurableObjectHostStorage } from "../src/layers/platform.js";

const runtimes: Array<
  ManagedRuntime.ManagedRuntime<ConfiguredHostOperationServices, unknown>
> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("ConfiguredHostContextLayer with Cloudflare primitives", () => {
  it("serves Code Mode operations through the configured Cloudflare runtime", async () => {
    const storage = makeMemoryStorage(
      new Map([
        [
          CONFIGURED_HOST_CONFIG_BLOB_KEY,
          makeConfiguredHostConfigBlob({
            mcpServers: {
              fixture: {
                transport: "http",
                url: PUBLIC_MCP_URL,
                headers: Option.none(),
                auth: Option.none(),
              },
            },
            serverCount: 1,
          }),
        ],
      ]),
    );
    const workerLoaderCalls: Array<{
      readonly code: WorkerLoaderWorkerCode;
      readonly payloadCode: string;
      readonly providers: ReadonlyArray<{
        readonly name: string;
        readonly tools: ReadonlyArray<string>;
      }>;
    }> = [];
    const runtime = makeRuntime({
      storage,
      workerLoader: makeRecordingWorkerLoader(workerLoaderCalls, {
        ok: true,
        value: { fromSandbox: true },
        logs: [{ level: "log", message: "executed", args: [] }],
        warnings: [],
      }),
    });

    const results = await runtime.runPromise(
      Effect.gen(function* () {
        const server = yield* CodeModeServer;

        const authStatus = yield* server.handle({ operation: "auth_status" });
        const refresh = yield* server.handle({ operation: "refresh" });
        const providers = yield* server.handle({
          operation: "search_providers",
          input: CodeModeSearchProvidersRequest.make({
            query: Option.none(),
            limit: Option.none(),
          }),
        });
        const search = yield* server.handle({
          operation: "search",
          input: CodeModeSearchRequest.make({
            query: "echo",
            provider: Option.none(),
            limit: Option.none(),
          }),
        });
        const schema = yield* server.handle({
          operation: "get_tool_schema",
          input: CodeModeToolSchemaRequest.make({ toolIds: ["fixture.echo"] }),
        });
        const execute = yield* server.handle({
          operation: "execute",
          input: CodeModeExecuteRequest.make({
            code: `async () => fixture.echo({ text: "hello from cloudflare" })`,
            timeoutMs: Option.none(),
          }),
        });

        return { authStatus, refresh, providers, search, schema, execute };
      }),
    );

    expect(results.authStatus).toMatchObject({
      operation: "auth_status",
      output: {
        authUrl: "https://ptools.example/hosts/demo/auth",
        servers: [
          {
            serverName: "fixture",
            jsServerName: "fixture",
            transport: "http",
            status: "connected",
            authUrl: "https://ptools.example/hosts/demo/auth",
          },
        ],
      },
    });
    expect(results.refresh).toEqual({
      operation: "refresh",
      output: { refreshed: true },
    });
    expect(results.providers).toMatchObject({
      operation: "search_providers",
      output: {
        providers: [
          {
            provider: "fixture",
            displayName: "fixture",
            toolCount: 2,
          },
        ],
        diagnostics: [],
      },
    });
    expect(results.search).toMatchObject({
      operation: "search",
      output: {
        actions: [
          {
            toolId: "fixture.echo",
            provider: "fixture",
            action: "echo",
          },
        ],
        diagnostics: [],
      },
    });
    expect(results.schema).toMatchObject({
      operation: "get_tool_schema",
      output: {
        tools: [
          {
            serverName: "fixture",
            jsServerName: "fixture",
            originalToolName: "echo",
            jsToolName: "echo",
          },
        ],
        diagnostics: [],
      },
    });
    if (results.schema.operation !== "get_tool_schema") {
      throw new Error("Expected get_tool_schema response.");
    }
    expect(
      results.schema.output.declarationsByServer[0]?.declaration,
    ).toContain("declare namespace fixture");
    expect(results.execute).toEqual({
      operation: "execute",
      output: {
        value: { text: "hello from cloudflare" },
        logs: [{ level: "log", message: "executed", args: [] }],
        warnings: [],
      },
    });
    expect(workerLoaderCalls).toHaveLength(1);
    expect(workerLoaderCalls[0]?.payloadCode).toBe(
      `async () => fixture.echo({ text: "hello from cloudflare" })`,
    );
    expect(workerLoaderCalls[0]?.providers).toEqual([
      { name: "fixture", tools: ["echo", "add"] },
    ]);
  });

  it("fails runtime startup with a typed config error when no host config is stored", async () => {
    const runtime = makeRuntime({
      storage: makeMemoryStorage(new Map()),
      workerLoader: makeRecordingWorkerLoader([], {
        ok: true,
        logs: [],
        warnings: [],
      }),
    });

    await expect(runtime.runtime()).rejects.toMatchObject({
      message: "Configured host config has not been configured.",
    });
  });
});

const makeConfiguredHostConfigBlob = (options: {
  readonly mcpServers: Parameters<typeof PtoolsConfig.make>[0]["mcpServers"];
  readonly serverCount: number;
}): string =>
  JSON.stringify(
    Effect.runSync(
      Schema.encode(ConfiguredHostConfigBlob)(
        ConfiguredHostConfigBlob.make({
          config: PtoolsConfig.make({
            mcpServers: options.mcpServers,
            executor: Option.none(),
          }),
          updatedAt: new Date(0).toISOString(),
          serverCount: options.serverCount,
        }),
      ),
    ),
  );

const makeRuntime = (options: {
  readonly storage: ReturnType<typeof makeMemoryStorage>;
  readonly workerLoader: CodeModeObjectWorkerLoaderService;
}): ManagedRuntime.ManagedRuntime<ConfiguredHostOperationServices, unknown> => {
  const platformLayer = Layer.mergeAll(
    HostIdentityLayer("demo"),
    Layer.succeed(HostStateStorageBackend, {
      forHost: () =>
        Effect.succeed(makeDurableObjectHostStorage(options.storage, "state")),
    }),
    Layer.succeed(HostSecretStorageBackend, {
      forHost: () =>
        Effect.succeed(makeDurableObjectHostStorage(options.storage, "secret")),
    }),
    Layer.succeed(CodeModeObjectWorkerLoader, options.workerLoader),
  );
  const cloudflarePrimitiveLayer = Layer.mergeAll(
    CloudflareMcpConnectorLayer.pipe(
      Layer.provide(CloudflareHttpMcpConnectorLayer),
    ),
    CloudflareDynamicWorkerSandboxRuntimeLayer,
  ).pipe(Layer.provideMerge(platformLayer));
  const runtime = ManagedRuntime.make(
    ConfiguredHostContextLayer.pipe(
      Layer.provide(HostStableSharedStoresLayer),
      Layer.provide(cloudflarePrimitiveLayer),
      Layer.provide(HostPublicOriginLayer("https://ptools.example")),
    ),
  );
  runtimes.push(runtime);
  return runtime;
};

const makeMemoryStorage = (
  values: Map<string, unknown>,
): DurableObjectStorage =>
  ({
    get: ((key: string) =>
      Promise.resolve(values.get(key))) as DurableObjectStorage["get"],
    put: ((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    }) as DurableObjectStorage["put"],
    delete: ((key: string | ReadonlyArray<string>) => {
      if (typeof key === "string") {
        return Promise.resolve(values.delete(key));
      }

      let deleted = 0;
      for (const item of key) {
        if (values.delete(item)) deleted += 1;
      }
      return Promise.resolve(deleted);
    }) as DurableObjectStorage["delete"],
    list: ((options?: DurableObjectListOptions) =>
      Promise.resolve(
        new Map(
          [...values.entries()].filter(([key]) =>
            options?.prefix === undefined
              ? true
              : key.startsWith(options.prefix),
          ),
        ),
      )) as DurableObjectStorage["list"],
  }) as DurableObjectStorage;

const makeRecordingWorkerLoader = (
  calls: Array<{
    readonly code: WorkerLoaderWorkerCode;
    readonly payloadCode: string;
    readonly providers: ReadonlyArray<{
      readonly name: string;
      readonly tools: ReadonlyArray<string>;
    }>;
  }>,
  completion: SandboxCompletion,
): CodeModeObjectWorkerLoaderService => ({
  loadSandbox: (code) =>
    Effect.succeed({
      runSandboxExecution: async (input, providerHandles) => {
        calls.push({
          code,
          payloadCode: input.payload.code,
          providers: input.payload.providers,
        });

        const fixture = providerHandles["fixture"];
        if (fixture !== undefined) {
          const result = await fixture.call(
            "echo",
            { text: "hello from cloudflare" },
            "fixture-call-1",
          );

          if (result.ok) {
            return { ...completion, value: result.value };
          }
        }

        return completion;
      },
    }),
});
