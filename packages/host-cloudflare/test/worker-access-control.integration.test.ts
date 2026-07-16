/// <reference path="./worker-env.d.ts" />

/**
 * Local workerd integration tests for Cloudflare Host API access control.
 *
 * These enter through real Worker HTTP middleware and verify bearer-token
 * rejection across the protected operation families. Successful principal
 * forwarding is covered by `worker-host-instance-rpc.integration.test.ts`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  configBody,
  handleRequest,
  publicAccessToken,
  secretsBody,
  uniqueHostId,
  codeModeSearchProvidersBody,
} from "./support/cloudflareWorkerTestClient.js";

describe("worker access control", () => {
  it("rejects missing auth with a bearer challenge", async () => {
    const response = await handleRequest("/hosts/demo/code-mode", {
      method: "POST",
      body: codeModeSearchProvidersBody(),
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
      body: codeModeSearchProvidersBody(),
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
      body: codeModeSearchProvidersBody(),
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
      body: codeModeSearchProvidersBody(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      _tag: "HostApiUnauthorized",
    });
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
});
