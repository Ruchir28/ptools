/// <reference path="./worker-env.d.ts" />

/**
 * Cloudflare Worker/workerd integration tests.
 *
 * These tests run through `@cloudflare/vitest-pool-workers` using
 * `wrangler.test.jsonc`, so the environment includes real platform-shaped
 * bindings: the Durable Object namespace and the `PTOOLS_EXECUTION_LOADER`
 * WorkerLoader binding. The Dynamic Worker tests in this file therefore load
 * and execute generated JavaScript in a real local Cloudflare Dynamic Worker,
 * not in a fake sandbox.
 *
 * The high-level execute test follows the production-shaped path:
 * Worker/Durable Object test stub -> real `CodeModeObject.call(...)` ->
 * `CodeModeServer` -> `CodeMode` -> `CloudflareDynamicWorkerExecutorLayer` ->
 * real `env.PTOOLS_EXECUTION_LOADER` -> generated code -> `ProviderBridge` ->
 * local HTTP MCP fixture.
 *
 * Some route/RPC-shape tests still use the `TestCodeModeObject.call(...)`
 * override to assert ingress behavior without starting the full Code Mode
 * runtime. Tests that need the real runtime call the explicit
 * `callRealCodeModeRuntime...ForTest(...)` helpers on that same object.
 */
import type { CodeModeResponse } from "@ptools/code-mode-api";
import { CodeExecutor, ExecuteRequest } from "@ptools/executor";
import { env } from "cloudflare:workers";
import { exports } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { CloudflareDynamicWorkerExecutorLayer } from "../src/layers/executor/dynamicWorkerRuntimeLayer.js";
import {
  CodeModeObjectWorkerLoader,
  makeCodeModeObjectWorkerLoader,
} from "../src/layers/executor/workerLoaderService.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  codeModeObjectTestCalls,
  resetCodeModeObjectTestState,
  setCodeModeObjectTestFailure,
  setCodeModeObjectTestResponse,
} from "./codeModeObjectTestState.js";

describe("Cloudflare Worker ingress", () => {
  beforeEach(() => {
    resetCodeModeObjectTestState();
  });

  it("returns health without touching Durable Objects", async () => {
    const response = await handleRequest("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(codeModeObjectTestCalls()).toEqual([]);
  });

  it("rejects missing auth with a bearer challenge", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      body: validBody(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostApiUnauthorized",
      message: "Unauthorized",
    });
  });

  it("rejects malformed auth", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: { Authorization: "Bearer token extra" },
      body: validBody(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostApiUnauthorized",
    });
  });

  it("rejects the wrong bearer token", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
      body: validBody(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostApiUnauthorized",
    });
  });

  it("rejects a wrong bearer token with the expected byte length", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"x".repeat(publicAccessToken.length)}`,
      },
      body: validBody(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostApiUnauthorized",
    });
  });

  it("returns host-api protocol failures for invalid JSON", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: "not json",
    });

    expect(response.status).toBe(400);
  });

  it("returns host-api protocol failures for invalid Code Mode envelopes", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(400);
  });

  it("uses host-api validation for operation input", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "search", input: {} }),
    });

    expect(response.status).toBe(400);
  });

  it("looks up the Durable Object by route host ID and calls typed RPC", async () => {
    const hostId = uniqueHostId();
    const responseBody: CodeModeResponse = {
      operation: "search_providers",
      output: { providers: [], diagnostics: [] },
    };
    setCodeModeObjectTestResponse(responseBody);

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: validBody(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "code_mode",
      result: { ok: true, response: responseBody },
    });
    expect(codeModeObjectTestCalls()).toEqual([
      {
        hostId,
        request: { operation: "search_providers" },
        origin: "https://ptools.example",
      },
    ]);
  });

  it("wraps host-api Code Mode requests in host-api responses", async () => {
    const hostId = uniqueHostId();
    const responseBody: CodeModeResponse = {
      operation: "search_providers",
      output: { providers: [], diagnostics: [] },
    };
    setCodeModeObjectTestResponse(responseBody);

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "search_providers" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "code_mode",
      result: { ok: true, response: responseBody },
    });
  });

  it("wraps host-api Code Mode operation failures in the operation result", async () => {
    const hostId = uniqueHostId();
    setCodeModeObjectTestFailure(new Error("boom"));

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "search_providers" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "code_mode",
      result: {
        ok: false,
        error: {
          code: "code_mode_server_failure",
          message: "Code Mode host is unavailable",
        },
      },
    });
  });

  it("returns host-api protocol failures for invalid code_mode envelopes", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it("decodes the route host ID before Durable Object lookup", async () => {
    const hostId = "team one";

    const response = await handleRequest("/hosts/team%20one/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: validBody(),
    });

    expect(response.status).toBe(200);
    expect(codeModeObjectTestCalls()).toEqual([
      {
        hostId,
        request: { operation: "search_providers" },
        origin: "https://ptools.example",
      },
    ]);
  });

  it("configures a named host with one unresolved config blob", async () => {
    const hostId = uniqueHostId();
    const rawConfigJson = configBody({
      headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
    });

    const response = await handleRequest(`/hosts/${hostId}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: rawConfigJson,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "configure",
      result: { ok: true, hostId, serverCount: 1 },
    });

    const stub = configTestStub(hostId);
    const blob = await stub.readConfigBlobForTest();

    expect(blob).toMatchObject({
      config: {
        mcpServers: {
          example: {
            transport: "http",
            headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
          },
        },
      },
      serverCount: 1,
    });
  });

  it("wraps host-api configure requests in host-api responses", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        config: {
          mcpServers: {
            example: { url: "https://mcp.example" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "configure",
      result: { ok: true, configured: true, hostId, serverCount: 1 },
    });
  });

  it("wraps host-api configure operation failures in the operation result", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        config: {
          mcpServers: {
            local: { command: "node" },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "configure",
      result: {
        ok: false,
        error: {
          code: "unsupported_config",
          message:
            'MCP server "local" uses stdio, which is not supported by the Cloudflare host first release. Cloudflare stdio MCP over Containers is deferred.',
        },
      },
    });
  });

  it("returns host-api protocol failures for invalid configure envelopes", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        config: { mcpServers: { bad: { url: 123 } } },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("configures per-host secrets as separate Durable Object keys", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/secrets`, {
      method: "PUT",
      headers: authHeaders(),
      body: secretsBody({
        TEST_MCP_TOKEN: "resolved-test-token",
        "path/like name": "another-secret",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "configure_secrets",
      result: { ok: true, hostId, secretCount: 2 },
    });

    const secrets = await configTestStub(hostId).readSecretsForTest();

    expect(secrets).toEqual({
      TEST_MCP_TOKEN: "resolved-test-token",
      "path/like name": "another-secret",
    });
  });

  it("wraps host-api configure_secrets requests in host-api responses", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/secrets`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        secrets: { TEST_MCP_TOKEN: "resolved-test-token" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "configure_secrets",
      result: { ok: true, configured: true, hostId, secretCount: 1 },
    });
  });

  it("returns host-api protocol failures for invalid configure_secrets envelopes", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/secrets`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ secrets: { TEST_MCP_TOKEN: 123 } }),
    });

    expect(response.status).toBe(400);
  });

  it("requires bearer auth for config bootstrap", async () => {
    const response = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      body: configBody(),
    });

    expect(response.status).toBe(401);
  });

  it("requires bearer auth for secret bootstrap", async () => {
    const response = await handleRequest(`/hosts/${uniqueHostId()}/secrets`, {
      method: "PUT",
      body: secretsBody({ TEST_MCP_TOKEN: "resolved-test-token" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns host-api protocol failures for malformed config and secrets JSON", async () => {
    const config = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: "not json",
    });
    const secrets = await handleRequest(`/hosts/${uniqueHostId()}/secrets`, {
      method: "PUT",
      headers: authHeaders(),
      body: "not json",
    });

    expect(config.status).toBe(400);
    expect(secrets.status).toBe(400);
  });

  it("resolves stored config secrets only when ResolvedPtoolsConfigSource loads", async () => {
    const hostId = uniqueHostId();
    const rawConfigJson = configBody({
      headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
    });

    await configureSecrets(hostId, {
      TEST_MCP_TOKEN: "resolved-test-token",
    });

    const response = await handleRequest(`/hosts/${hostId}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: rawConfigJson,
    });

    expect(response.status).toBe(200);

    const resolved =
      await configTestStub(hostId).loadResolvedConfigResultForTest();

    expect(resolved).toEqual({
      ok: true,
      config: {
        mcpServers: {
          example: {
            transport: "http",
            url: "https://mcp.example",
            headers: { Authorization: "Bearer resolved-test-token" },
          },
        },
      },
    });
  });

  it("uses rotated secrets on the next ResolvedPtoolsConfigSource load without re-uploading config", async () => {
    const hostId = uniqueHostId();

    await configureSecrets(hostId, {
      TEST_MCP_TOKEN: "first-token",
    });
    await configureHost(
      hostId,
      configBody({
        headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
      }),
    );

    await expect(
      configTestStub(hostId).loadResolvedConfigResultForTest(),
    ).resolves.toMatchObject({
      ok: true,
      config: {
        mcpServers: {
          example: {
            headers: { Authorization: "Bearer first-token" },
          },
        },
      },
    });

    await configureSecrets(hostId, {
      TEST_MCP_TOKEN: "rotated-token",
    });

    await expect(
      configTestStub(hostId).loadResolvedConfigResultForTest(),
    ).resolves.toMatchObject({
      ok: true,
      config: {
        mcpServers: {
          example: {
            headers: { Authorization: "Bearer rotated-token" },
          },
        },
      },
    });
  });

  it("fails ResolvedPtoolsConfigSource.load when a stored secret is missing", async () => {
    const hostId = uniqueHostId();

    await configureHost(
      hostId,
      configBody({
        headers: { Authorization: "Bearer ${env:MISSING_MCP_TOKEN}" },
      }),
    );

    await expect(
      configTestStub(hostId).loadResolvedConfigResultForTest(),
    ).resolves.toMatchObject({
      ok: false,
      message:
        "Missing environment variable MISSING_MCP_TOKEN for headers.Authorization on MCP server example",
    });

    const blob = await configTestStub(hostId).readConfigBlobForTest();
    expect(blob?.config.mcpServers.example).toMatchObject({
      headers: { Authorization: "Bearer ${env:MISSING_MCP_TOKEN}" },
    });
  });

  it("fails ResolvedPtoolsConfigSource.load when the stored config blob is invalid", async () => {
    const hostId = uniqueHostId();
    const stub = configTestStub(hostId);

    await stub.writeConfigBlobForTest({
      config: {
        mcpServers: {
          example: {
            transport: "http",
            url: 42,
          },
        },
      },
      updatedAt: new Date().toISOString(),
      serverCount: 1,
    });

    await expect(stub.loadResolvedConfigResultForTest()).resolves.toEqual({
      ok: false,
      message: "Stored configured host config is invalid.",
    });
  });

  it("replaces the per-host secret key set on secret bootstrap", async () => {
    const hostId = uniqueHostId();

    await configureSecrets(hostId, {
      OLD_TOKEN: "old-secret",
      TEST_MCP_TOKEN: "first-secret",
    });
    await configureSecrets(hostId, {
      TEST_MCP_TOKEN: "replacement-secret",
    });

    await expect(configTestStub(hostId).readSecretsForTest()).resolves.toEqual({
      TEST_MCP_TOKEN: "replacement-secret",
    });
  });

  it("rejects invalid secrets", async () => {
    const response = await handleRequest(`/hosts/${uniqueHostId()}/secrets`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ secrets: { TEST_MCP_TOKEN: 123 } }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects invalid and unsupported Cloudflare host configs", async () => {
    const invalid = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ config: { mcpServers: [] } }),
    });
    const stdio = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        config: {
          mcpServers: {
            local: { command: "node" },
          },
        },
      }),
    });

    expect(invalid.status).toBe(400);
    expect(stdio.status).toBe(200);
    await expect(stdio.json()).resolves.toMatchObject({
      operation: "configure",
      result: { ok: false, error: { code: "unsupported_config" } },
    });
  });

  it("keeps host config isolated and overwrites the blob on replacement", async () => {
    const firstHostId = uniqueHostId();
    const secondHostId = uniqueHostId();

    await configureHost(firstHostId, configBody());
    await configureHost(
      secondHostId,
      configBody({ url: "https://second.example" }),
    );
    await configureHost(
      firstHostId,
      configBody({ url: "https://replacement.example" }),
    );

    const firstBlob = await configTestStub(firstHostId).readConfigBlobForTest();
    const secondBlob =
      await configTestStub(secondHostId).readConfigBlobForTest();

    expect(firstBlob?.config.mcpServers.example).toMatchObject({
      url: "https://replacement.example",
    });
    expect(secondBlob?.config.mcpServers.example).toMatchObject({
      url: "https://second.example",
    });
  });

  it("requires bearer auth for MCP auth status and start routes", async () => {
    const hostId = uniqueHostId();
    const status = await handleRequest(`/hosts/${hostId}/auth/status`, {
      method: "POST",
    });
    const start = await handleRequest(`/hosts/${hostId}/auth/example`, {
      method: "POST",
    });

    expect(status.status).toBe(401);
    expect(start.status).toBe(401);
  });

  it("serves real Code Mode requests through CodeModeObject.call for configured hosts", async () => {
    const hostId = uniqueHostId();

    await configureHost(hostId, emptyConfigBody());

    await expect(
      configTestStub(hostId).callRealCodeModeRuntimeForTest({
        origin: "https://ptools.example",
        request: { operation: "search_providers" },
      }),
    ).resolves.toEqual({
      operation: "search_providers",
      output: { providers: [], diagnostics: [] },
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

  it("executes generated code in a real Dynamic Worker through CodeModeObject.call", async () => {
    const hostId = uniqueHostId();

    await configureHost(
      hostId,
      configBody({ url: "http://127.0.0.1:19719/mcp" }),
    );

    const stub = configTestStub(hostId);

    await expect(
      stub.callRealCodeModeRuntimeForTest({
        origin: "https://ptools.example",
        request: { operation: "refresh" },
      }),
    ).resolves.toEqual({
      operation: "refresh",
      output: { refreshed: true },
    });

    const search = await stub.callRealCodeModeRuntimeFromUnknownForTest({
      origin: "https://ptools.example",
      request: {
        operation: "search",
        input: { query: "echo", limit: 1 },
      },
    });

    expect(search).toMatchObject({
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
    });
    if (search.operation !== "search") {
      throw new Error("Expected search response.");
    }
    const discoveredEcho = search.output.actions[0];
    if (discoveredEcho === undefined) {
      throw new Error("Expected search to discover an echo tool.");
    }

    const result = await stub.callRealCodeModeRuntimeResultForTest({
      origin: "https://ptools.example",
      request: {
        operation: "execute",
        input: {
          code: `async () => {
            const echo = await ${discoveredEcho.provider}.${discoveredEcho.action}({ text: "hello dynamic worker" });
            const add = await example.add({ a: 2, b: 3 });

            return { echo, add };
          }`,
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
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
    });
  });

  it("reports MCP auth status from the named Durable Object config", async () => {
    const hostId = uniqueHostId();

    await configureHost(
      hostId,
      configBody({
        headers: { Authorization: "Bearer static-token" },
      }),
    );

    const response = await handleRequest(`/hosts/${hostId}/auth/status`, {
      method: "POST",
      headers: authHeaders(),
      body: mcpAuthStatusBody(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "mcp_auth_status",
      result: {
        ok: true,
        status: {
          authUrl: `https://ptools.example/hosts/${hostId}/auth`,
          servers: [
            {
              serverName: "example",
              jsServerName: "example",
              transport: "http",
              status: "auth_failed",
              authUrl: `https://ptools.example/hosts/${hostId}/auth`,
            },
          ],
        },
      },
    });
  });

  it("adapts MCP auth status to a host-api response", async () => {
    const hostId = uniqueHostId();

    await configureHost(
      hostId,
      configBody({
        headers: { Authorization: "Bearer static-token" },
      }),
    );

    const response = await handleRequest(`/hosts/${hostId}/auth/status`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "mcp_auth_status",
      result: {
        ok: true,
        status: {
          authUrl: `https://ptools.example/hosts/${hostId}/auth`,
          servers: [{ serverName: "example", status: "auth_failed" }],
        },
      },
    });
  });

  it("wraps auth operation failures in the operation result", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/auth/example`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operation: "start_mcp_auth",
      result: { ok: false, error: { code: "invalid_config" } },
    });
  });

  it("does not serve unsigned browser OAuth start helper routes", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/auth/example`, {
      method: "GET",
      headers: authHeaders(),
    });

    expect(response.status).toBe(404);
  });

  it("rebuilds the cached host runtime when the request origin changes", async () => {
    const hostId = uniqueHostId();

    await configureHost(
      hostId,
      configBody({
        headers: { Authorization: "Bearer static-token" },
      }),
    );

    const first = await handleRequest(`/hosts/${hostId}/auth/status`, {
      method: "POST",
      headers: authHeaders(),
      body: mcpAuthStatusBody("https://ptools.example"),
    });
    const second = await handleRequest(
      `https://alternate.ptools.example/hosts/${hostId}/auth/status`,
      {
        method: "POST",
        headers: authHeaders(),
        body: mcpAuthStatusBody("https://alternate.ptools.example"),
      },
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      result: {
        status: { authUrl: `https://ptools.example/hosts/${hostId}/auth` },
      },
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      result: {
        status: {
          authUrl: `https://alternate.ptools.example/hosts/${hostId}/auth`,
        },
      },
    });
  });

  it("does not serve unsigned browser OAuth setup helper routes", async () => {
    const hostId = uniqueHostId();
    await configureHost(hostId, configBody());

    const response = await handleRequest(
      `/hosts/${hostId}/auth/example/setup`,
      { headers: authHeaders() },
    );

    expect(response.status).toBe(404);
  });

  it("forwards OAuth callbacks without public bearer auth and rejects invalid DO-owned state", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(
      `/hosts/${hostId}/oauth/callback/example?code=abc&state=not-signed`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostHttpBadRequest",
    });
  });

  it("accepts POST OAuth callback form bodies without public bearer auth", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(
      `/hosts/${hostId}/oauth/callback/example`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code: "abc",
          state: "not-signed",
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostHttpBadRequest",
    });
  });

  it("rejects OAuth callback state signed for another host", async () => {
    const hostId = uniqueHostId();
    const otherHostId = uniqueHostId();
    const state = await configTestStub(otherHostId).signOAuthStateForTest({
      provider: "example",
      hostId: otherHostId,
      serverName: "example",
      nonce: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const response = await handleRequest(
      `/hosts/${hostId}/oauth/callback/example?code=abc&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostHttpBadRequest",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest("/missing");

    expect(response.status).toBe(404);
  });

  it("returns 405 for unsupported methods on known routes", async () => {
    const health = await handleRequest("/health", { method: "POST" });
    const codeMode = await handleRequest("/hosts/demo/code-mode", {
      method: "GET",
    });
    const config = await handleRequest("/hosts/demo/config", {
      method: "POST",
    });
    const secrets = await handleRequest("/hosts/demo/secrets", {
      method: "POST",
    });
    const mcpAuthStatus = await handleRequest("/hosts/demo/auth/status", {
      method: "PUT",
    });
    const mcpAuthStart = await handleRequest("/hosts/demo/auth/example", {
      method: "PUT",
    });
    const mcpAuthSetup = await handleRequest("/hosts/demo/auth/example/setup", {
      method: "PUT",
    });
    const oauthCallback = await handleRequest(
      "/hosts/demo/oauth/callback/example",
      {
        method: "PUT",
      },
    );

    expect(health.status).toBe(405);
    expect(health.headers.get("Allow")).toBe("GET");
    expect(codeMode.status).toBe(404);
    expect(config.status).toBe(404);
    expect(secrets.status).toBe(404);
    expect(mcpAuthStatus.status).toBe(404);
    expect(mcpAuthStart.status).toBe(404);
    expect(mcpAuthSetup.status).toBe(404);
    expect(oauthCallback.status).toBe(404);
  });
});

const publicAccessToken = "test-public-token";

const handleRequest = async (
  pathOrUrl: string,
  options: {
    readonly method?: string;
    readonly headers?: HeadersInit;
    readonly body?: BodyInit;
  } = {},
): Promise<Response> => {
  const url = new URL(pathOrUrl, "https://ptools.example").toString();
  const request = new Request(url, requestInit(options));

  return exports.default.fetch(request);
};

const requestInit = (options: {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
}): RequestInit => {
  const headers = jsonHeaders(options.headers, options.body);

  return {
    method: options.method ?? "GET",
    ...(headers === undefined ? {} : { headers }),
    ...(options.body === undefined ? {} : { body: options.body }),
  };
};

const jsonHeaders = (
  headers: HeadersInit | undefined,
  body: BodyInit | undefined,
): HeadersInit | undefined => {
  if (body === undefined) {
    return headers;
  }

  const result = new Headers(headers);
  if (!result.has("content-type")) {
    result.set("content-type", "application/json");
  }
  return result;
};

const authHeaders = (): HeadersInit => ({
  Authorization: `Bearer ${publicAccessToken}`,
});

const validBody = (): string =>
  JSON.stringify({ operation: "search_providers" });

const configBody = (
  server: {
    readonly url?: string;
    readonly headers?: Record<string, string>;
  } = {},
): string =>
  JSON.stringify({
    config: {
      mcpServers: {
        example: {
          url: server.url ?? "https://mcp.example",
          ...(server.headers === undefined ? {} : { headers: server.headers }),
        },
      },
    },
  });

const emptyConfigBody = (): string =>
  JSON.stringify({ config: { mcpServers: {} } });

const configureHost = async (hostId: string, body: string): Promise<void> => {
  const response = await handleRequest(`/hosts/${hostId}/config`, {
    method: "PUT",
    headers: authHeaders(),
    body,
  });

  expect(response.status).toBe(200);
};

const secretsBody = (secrets: Record<string, string>): string =>
  JSON.stringify({ secrets });

const mcpAuthStatusBody = (_origin?: string): string => JSON.stringify({});

const configureSecrets = async (
  hostId: string,
  secrets: Record<string, string>,
): Promise<void> => {
  const response = await handleRequest(`/hosts/${hostId}/secrets`, {
    method: "PUT",
    headers: authHeaders(),
    body: secretsBody(secrets),
  });

  expect(response.status).toBe(200);
};

const configTestStub = (hostId: string) =>
  env.PTOOLS_CODE_MODE.getByName(hostId);

const uniqueHostId = (): string => `test-${crypto.randomUUID()}`;
