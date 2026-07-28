/**
 * Promise and Effect client coverage for an already-running Host HTTP API.
 *
 * Background — HostHttpClientFetchLive owns the single config-validation and
 * transport path. createHostHttpClient only retains that layer in a
 * ManagedRuntime and projects Promise methods.
 *
 * What this proves:
 *   1. Invalid config is a typed Effect failure and the same Promise rejection.
 *   2. One supplied layer instance serves both Host and Code Mode capabilities.
 *   3. The Promise handle uses encoded host routes and bearer auth.
 *   4. Closing a remote client sends no server/actor lifecycle request.
 *
 * Fetch is faked to inspect the carrier boundary; schemas, Effect layers,
 * ManagedRuntime ownership, and Promise adaptation are real.
 */
import {
  HostHttpClient,
  HostHttpClientConfigError,
  HostHttpClientFetchLive,
  makeHostHttpClientHandle,
} from "../src/services/index.js";
import { createHostHttpClient } from "../src/http/index.js";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("shared Host HTTP client constructors", () => {
  it("fails invalid URLs through the typed Effect channel and same Promise path", async () => {
    const config = {
      baseUrl: "not a URL",
      hostId: "demo",
      accessToken: "token",
    };

    const effectFailure = await Effect.runPromise(
      Effect.scoped(Layer.build(HostHttpClientFetchLive(config))).pipe(
        Effect.flip,
      ),
    );
    expect(effectFailure).toBeInstanceOf(HostHttpClientConfigError);
    expect(effectFailure.message).toBe(
      "Host HTTP baseUrl must be a valid absolute URL.",
    );

    await expect(createHostHttpClient(config)).rejects.toThrow(
      "Host HTTP baseUrl must be a valid absolute URL.",
    );
  });

  it("acquires the supplied HostHttpClient layer once for both handle capabilities", async () => {
    let acquisitions = 0;
    let releases = 0;
    const hostLayer = Layer.scoped(
      HostHttpClient,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1;
          return HostHttpClient.of({
            codeMode: () => Effect.die("unused"),
            configure: () => Effect.die("unused"),
            configureSecrets: () => Effect.die("unused"),
            mcpAuthStatus: () => Effect.die("unused"),
            startMcpAuth: () => Effect.die("unused"),
          });
        }),
        () =>
          Effect.sync(() => {
            releases += 1;
          }),
      ),
    );

    const host = await makeHostHttpClientHandle(hostLayer);
    expect(acquisitions).toBe(1);
    await host.close();
    expect(releases).toBe(1);
  });

  it("uses the named routes and closes without a remote shutdown request", async () => {
    const requests: Array<Request> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        const operation = request.url.endsWith("/auth/notion")
          ? {
              operation: "start_mcp_auth",
              result: {
                ok: true,
                authorizeUrl: "https://notion.example/oauth",
              },
            }
          : {
              operation: "configure",
              result: { ok: true, configured: true },
            };
        return new Response(JSON.stringify(operation), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as typeof fetch;

    const host = await createHostHttpClient({
      baseUrl: "https://ptools.example/",
      hostId: "demo host",
      accessToken: "secret-token",
    });

    await expect(
      host.call({
        operation: "configure",
        input: {
          config: { mcpServers: {}, executor: Option.none() },
        },
      }),
    ).resolves.toMatchObject({ result: { ok: true } });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://ptools.example/hosts/demo%20host/config",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer secret-token",
    );

    await expect(
      host.call({
        operation: "start_mcp_auth",
        input: { serverName: "notion", force: true },
      }),
    ).resolves.toMatchObject({
      operation: "start_mcp_auth",
      result: { ok: true },
    });
    expect(requests[1]?.url).toBe(
      "https://ptools.example/hosts/demo%20host/auth/notion",
    );
    await expect(requests[1]?.json()).resolves.toEqual({ force: true });

    await host.close();
    expect(requests).toHaveLength(2);
  });
});
