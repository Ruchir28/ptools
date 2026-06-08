import type { CodeModeResponse } from "@ptools/code-mode-api";
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
      headers: { Authorization: `Bearer ${"x".repeat(publicAccessToken.length)}` },
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

    expect(health.status).toBe(405);
    expect(health.headers.get("Allow")).toBe("GET");
    expect(codeMode.status).toBe(405);
    expect(codeMode.headers.get("Allow")).toBe("POST");
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

const uniqueHostId = (): string => `test-${crypto.randomUUID()}`;
