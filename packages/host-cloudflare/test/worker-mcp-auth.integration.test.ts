/// <reference path="./worker-env.d.ts" />

/**
 * Local workerd integration tests for MCP auth and browser OAuth.
 *
 * These cross Worker HTTP ingress, named Durable Object RPC, shared auth
 * services, and durable state/credential stores. The happy path talks to the
 * local OAuth fixture; no deployed Worker or external identity provider is used.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_MCP_ORIGIN,
  FIXTURE_OAUTH_AUTHORIZATION_CODE,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_PROTECTED_MCP_URL,
} from "./support/fixtureMcpEndpoints.js";
import {
  authHeaders,
  configBody,
  configTestStub,
  configureHost,
  handleRequest,
  mcpAuthStatusBody,
  uniqueHostId,
} from "./support/cloudflareWorkerTestClient.js";

describe("worker mcp auth", () => {
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

  /**
   * Complete the production-shaped browser OAuth path across HTTP ingress,
   * Durable Object RPC, the shared host handler, signed state storage, and the
   * local fixture authorization server. Only the upstream authorization server
   * is a fixture; the Cloudflare and shared runtime path is real.
   */
  it("starts and completes OAuth through the named Durable Object", async () => {
    const hostId = uniqueHostId();
    await configureHost(
      hostId,
      JSON.stringify({
        config: {
          mcpServers: {
            example: {
              url: OAUTH_PROTECTED_MCP_URL,
              auth: { type: "oauth", clientId: "fixture-client" },
            },
          },
        },
      }),
    );

    const started = await handleRequest(`/hosts/${hostId}/auth/example`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ force: true }),
    });
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as {
      readonly result?: {
        readonly ok?: boolean;
        readonly authorizeUrl?: string;
      };
    };
    expect(startedBody.result?.ok).toBe(true);
    const authorizeUrl = new URL(startedBody.result?.authorizeUrl ?? "");
    const state = authorizeUrl.searchParams.get("state");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      `${FIXTURE_MCP_ORIGIN}${OAUTH_AUTHORIZE_PATH}`,
    );
    expect(state).toBeTruthy();

    const callbackUrl =
      `/hosts/${hostId}/oauth/callback/example` +
      `?code=${FIXTURE_OAUTH_AUTHORIZATION_CODE}&state=${encodeURIComponent(state ?? "")}`;
    const completed = await handleRequest(callbackUrl);
    const completedBody = await completed.text();
    expect(completed.status, completedBody).toBe(200);
    expect(completed.headers.get("content-type")).toContain("text/html");
    expect(completedBody).toContain("Authorization complete");

    // Refresh reconnects the real MCP client with the newly persisted OAuth
    // access token. The protected resource accepts only that issued token.
    const refresh = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "refresh" }),
    });
    expect(refresh.status).toBe(200);
    await expect(refresh.json()).resolves.toMatchObject({
      result: { ok: true, response: { operation: "refresh" } },
    });

    const providers = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ operation: "search_providers" }),
    });
    expect(providers.status).toBe(200);
    await expect(providers.json()).resolves.toMatchObject({
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

    // OAuth state is consumed exactly once inside this host's Durable Object.
    const replayed = await handleRequest(callbackUrl);
    expect(replayed.status).toBe(400);
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
      body: mcpAuthStatusBody(),
    });
    const second = await handleRequest(
      `https://alternate.ptools.example/hosts/${hostId}/auth/status`,
      {
        method: "POST",
        headers: authHeaders(),
        body: mcpAuthStatusBody(),
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
});
