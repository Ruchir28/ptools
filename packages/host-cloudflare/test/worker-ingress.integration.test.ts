/// <reference path="./worker-env.d.ts" />

/**
 * Local workerd integration tests for Host HTTP routing and protocol decoding.
 *
 * These execute the real Worker, shared Host API, named Durable Object, and
 * shared host handler. Representative Code Mode responses come from a real
 * configured runtime; this file stays focused on ingress and projection.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { codeModeObjectTestCallsForHost } from "./codeModeObjectTestState.js";
import {
  authHeaders,
  codeModeSearchProvidersBody,
  configureHost,
  emptyConfigBody,
  handleRequest,
  uniqueHostId,
} from "./support/cloudflareWorkerTestClient.js";

describe("worker ingress", () => {
  it("returns the public health response", async () => {
    const response = await handleRequest("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
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

  it("wraps host-api Code Mode requests in host-api responses", async () => {
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

  it("wraps host-api Code Mode operation failures in the operation result", async () => {
    const hostId = uniqueHostId();
    await configureHost(hostId, emptyConfigBody());

    const response = await handleRequest(`/hosts/${hostId}/code-mode`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        operation: "execute",
        input: { code: 'async () => { throw new Error("boom") }' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      operation: "code_mode",
      result: {
        ok: false,
        error: {
          code: "code_mode_server_failure",
          message: "Code Mode request failed.",
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
    await configureHost(hostId, emptyConfigBody());

    const response = await handleRequest("/hosts/team%20one/code-mode", {
      method: "POST",
      headers: authHeaders(),
      body: codeModeSearchProvidersBody(),
    });

    expect(response.status).toBe(200);
    expect(codeModeObjectTestCallsForHost(hostId)).toEqual([
      {
        hostId,
        request: { operation: "search_providers" },
        origin: "https://ptools.example",
        caller: { kind: "HostApiTokenCaller" },
      },
    ]);
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
