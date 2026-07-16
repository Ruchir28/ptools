/// <reference path="./worker-env.d.ts" />

/**
 * Local workerd integration tests for host config and secret lifecycle.
 *
 * Requests cross Worker ingress and Durable Object RPC into real stable stores.
 * The suite verifies replacement, host isolation, validation, secret
 * resolution, rotation, and storage-backed failure behavior.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_STATIC_BEARER_TOKEN,
  STATIC_BEARER_MCP_URL,
} from "./support/fixtureMcpEndpoints.js";
import {
  authHeaders,
  configBody,
  configTestStub,
  configureHost,
  configureSecrets,
  handleRequest,
  secretsBody,
  uniqueHostId,
} from "./support/cloudflareWorkerTestClient.js";

describe("worker host configuration", () => {
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
            'MCP server "local" uses stdio, which is not supported by this host.',
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
        TEST_MCP_TOKEN: FIXTURE_STATIC_BEARER_TOKEN,
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
      TEST_MCP_TOKEN: FIXTURE_STATIC_BEARER_TOKEN,
      "path/like name": "another-secret",
    });
  });

  it("wraps host-api configure_secrets requests in host-api responses", async () => {
    const hostId = uniqueHostId();
    const response = await handleRequest(`/hosts/${hostId}/secrets`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        secrets: { TEST_MCP_TOKEN: FIXTURE_STATIC_BEARER_TOKEN },
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

  it("uses a resolved secret header in a real MCP connection", async () => {
    const hostId = uniqueHostId();
    await configureSecrets(hostId, {
      TEST_MCP_TOKEN: FIXTURE_STATIC_BEARER_TOKEN,
    });
    await configureHost(
      hostId,
      configBody({
        url: STATIC_BEARER_MCP_URL,
        headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
      }),
    );

    const response = await searchProviders(hostId);

    expect(response).toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search_providers",
          output: {
            providers: [{ provider: "example", toolCount: 2 }],
            diagnostics: [],
          },
        },
      },
    });
  });

  it("reconnects with a rotated secret without re-uploading config", async () => {
    const hostId = uniqueHostId();
    await configureSecrets(hostId, { TEST_MCP_TOKEN: "wrong-token" });
    await configureHost(
      hostId,
      configBody({
        url: STATIC_BEARER_MCP_URL,
        headers: { Authorization: "Bearer ${env:TEST_MCP_TOKEN}" },
      }),
    );

    expect(await searchProviders(hostId)).toMatchObject({
      result: {
        ok: true,
        response: {
          output: {
            providers: [],
            diagnostics: [
              {
                code: "UpstreamAuthRequired",
                severity: "warning",
                serverName: "example",
                message: "Authorize example from the ptools host auth route.",
                authUrl: expect.any(String),
              },
            ],
          },
        },
      },
    });

    await configureSecrets(hostId, {
      TEST_MCP_TOKEN: FIXTURE_STATIC_BEARER_TOKEN,
    });

    expect(await searchProviders(hostId)).toMatchObject({
      result: {
        ok: true,
        response: {
          output: {
            providers: [{ provider: "example", toolCount: 2 }],
            diagnostics: [],
          },
        },
      },
    });
  });

  it("surfaces a missing referenced secret through the public Code Mode operation", async () => {
    const hostId = uniqueHostId();
    await configureHost(
      hostId,
      configBody({
        url: STATIC_BEARER_MCP_URL,
        headers: { Authorization: "Bearer ${env:MISSING_MCP_TOKEN}" },
      }),
    );

    expect(await searchProviders(hostId)).toMatchObject({
      operation: "code_mode",
      result: {
        ok: false,
        error: { code: "code_mode_server_failure" },
      },
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
});

/** Invoke the public Code Mode provider-discovery operation for one host. */
const searchProviders = async (hostId: string): Promise<unknown> => {
  const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ operation: "search_providers" }),
  });

  expect(response.status).toBe(200);
  return response.json();
};
