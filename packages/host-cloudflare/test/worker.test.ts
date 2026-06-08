import type { CodeModeResponse } from "@ptools/code-mode-api";
import { env } from "cloudflare:workers";
import { exports } from "cloudflare:workers";
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
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthorized", message: "Unauthorized" },
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
      error: { code: "unauthorized" },
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
      error: { code: "unauthorized" },
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
      error: { code: "unauthorized" },
    });
  });

  it("rejects invalid JSON", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: "not json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_json" },
    });
  });

  it("rejects invalid Code Mode requests", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ input: {} }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_code_mode_request" },
    });
  });

  it("uses Code Mode API validation for operation input", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "search", input: {} }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_code_mode_request" },
    });
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
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(codeModeObjectTestCalls()).toEqual([
      { hostId, request: { operation: "search_providers" } },
    ]);
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
      { hostId, request: { operation: "search_providers" } },
    ]);
  });

  it("maps Durable Object call failures to 502", async () => {
    const hostId = uniqueHostId();
    setCodeModeObjectTestFailure("runtime not ready");

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: validBody(),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "code_mode_unavailable",
        message: "Code Mode host is unavailable",
      },
    });
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
      hostId,
      serverCount: 1,
    });

    const stub = configTestStub(hostId);
    const blob = await stub.readConfigBlobForTest();

    expect(blob).toMatchObject({
      rawJson: rawConfigJson,
      serverCount: 1,
    });
    expect(blob?.rawJson).toContain("${env:TEST_MCP_TOKEN}");
    expect(blob?.rawJson).not.toContain("resolved-test-token");
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
      hostId,
      secretCount: 2,
    });

    const secrets = await configTestStub(hostId).readSecretsForTest();

    expect(secrets).toEqual({
      TEST_MCP_TOKEN: "resolved-test-token",
      "path/like name": "another-secret",
    });
  });

  it("requires bearer auth for config bootstrap", async () => {
    const response = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      body: configBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("requires bearer auth for secret bootstrap", async () => {
    const response = await handleRequest(`/hosts/${uniqueHostId()}/secrets`, {
      method: "PUT",
      body: secretsBody({ TEST_MCP_TOKEN: "resolved-test-token" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects malformed config and secrets JSON", async () => {
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
    await expect(config.json()).resolves.toMatchObject({
      error: { code: "invalid_config" },
    });
    expect(secrets.status).toBe(400);
    await expect(secrets.json()).resolves.toMatchObject({
      error: { code: "invalid_secrets" },
    });
  });

  it("resolves stored config secrets only when ConfigSource loads", async () => {
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

  it("uses rotated secrets on the next ConfigSource load without re-uploading config", async () => {
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

  it("fails ConfigSource.load when a stored secret is missing", async () => {
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
    expect(blob?.rawJson).toContain("${env:MISSING_MCP_TOKEN}");
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
      body: JSON.stringify({ TEST_MCP_TOKEN: 123 }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_secrets" },
    });
  });

  it("rejects invalid and unsupported Cloudflare host configs", async () => {
    const invalid = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ mcpServers: [] }),
    });
    const stdio = await handleRequest(`/hosts/${uniqueHostId()}/config`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        mcpServers: {
          local: { command: "node" },
        },
      }),
    });

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_config" },
    });
    expect(stdio.status).toBe(400);
    await expect(stdio.json()).resolves.toMatchObject({
      error: { code: "unsupported_config" },
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

    expect(firstBlob?.rawJson).toContain("https://replacement.example");
    expect(firstBlob?.rawJson).not.toContain("https://mcp.example");
    expect(secondBlob?.rawJson).toContain("https://second.example");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await handleRequest("/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
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

    expect(health.status).toBe(405);
    expect(health.headers.get("Allow")).toBe("GET");
    expect(codeMode.status).toBe(405);
    expect(codeMode.headers.get("Allow")).toBe("POST");
    expect(config.status).toBe(405);
    expect(config.headers.get("Allow")).toBe("PUT");
    expect(secrets.status).toBe(405);
    expect(secrets.headers.get("Allow")).toBe("PUT");
  });
});

const publicAccessToken = "test-public-token";

const handleRequest = async (
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: HeadersInit;
    readonly body?: BodyInit;
  } = {},
): Promise<Response> => {
  const request = new Request(
    `https://ptools.example${path}`,
    requestInit(options),
  );

  return exports.default.fetch(request);
};

const requestInit = (options: {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
}): RequestInit => ({
  method: options.method ?? "GET",
  ...(options.headers === undefined ? {} : { headers: options.headers }),
  ...(options.body === undefined ? {} : { body: options.body }),
});

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
    mcpServers: {
      example: {
        url: server.url ?? "https://mcp.example",
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      },
    },
  });

const configureHost = async (hostId: string, body: string): Promise<void> => {
  const response = await handleRequest(`/hosts/${hostId}/config`, {
    method: "PUT",
    headers: authHeaders(),
    body,
  });

  expect(response.status).toBe(200);
};

const secretsBody = (secrets: Record<string, string>): string =>
  JSON.stringify(secrets);

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
