import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  CodeModeInvalidRequestError,
  CodeModeRemoteError,
  CodeModeSearchRequest,
} from "@ptools/code-mode-api";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import {
  HostHttpClient,
  HostHttpClientLive,
  CodeModeClientFromHostHttpClientLive,
  HostHttpIngress,
  HostHttpOperationAdapter,
  HostHttpOperationAdapterLive,
  HostInstanceDiscovery,
  HostOperationDispatchError,
  VerifiedHostApiCaller,
} from "../src/services/index.js";
import {
  parseHostOperationRequest,
  HostCodeModeResponse,
  HostOperationDispatchInput,
  parseHostOperationResponse,
  type HostOperationResponse,
} from "../src/index.js";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("host-api source layout", () => {
  it("keeps reusable DTOs under contracts and Effect services under services", async () => {
    await expect(fileExists(join(packageRoot, "src/contracts"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/services"))).resolves.toBe(
      true,
    );
    await expect(fileExists(join(packageRoot, "src/http"))).resolves.toBe(true);
    await expect(fileExists(join(packageRoot, "src/effect"))).resolves.toBe(
      false,
    );

    for (const forbiddenRootFile of [
      "configureHostSchema.ts",
      "hostApiSchema.ts",
      "hostAuthSchema.ts",
      "hostCodeModeSchema.ts",
      "hostSecretsSchema.ts",
      "hostApiCodec.ts",
      "hostApiResponseHelpers.ts",
      "hostApiValidation.ts",
    ]) {
      await expect(
        fileExists(join(packageRoot, "src", forbiddenRootFile)),
      ).resolves.toBe(false);
    }

    await expect(
      fileExists(join(packageRoot, "src/contracts/hostApiEnvelope.ts")),
    ).resolves.toBe(false);
    await expect(
      fileExists(join(packageRoot, "src/contracts/hostOperationEnvelope.ts")),
    ).resolves.toBe(true);
  });

  it("keeps shared contracts, services, and HTTP code free of platform imports", async () => {
    const files = [
      ...(await tsFiles(join(packageRoot, "src/contracts"))),
      ...(await tsFiles(join(packageRoot, "src/services"))),
      ...(await tsFiles(join(packageRoot, "src/http"))),
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(cloudflare|hono|host-cloudflare|host-node|cloudflare:workers|@cloudflare)[^"']*["']/,
      );
    }
  });
});

describe("host-api schemas", () => {
  it("decodes code_mode requests and responses", async () => {
    const request = await Effect.runPromise(
      parseHostOperationRequest({
        operation: "code_mode",
        input: {
          operation: "search",
          input: { query: "github" },
        },
      }),
    );

    expect(request.operation).toBe("code_mode");

    const response: HostOperationResponse = {
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: { actions: [], diagnostics: [] },
        },
      },
    };

    await expect(
      Effect.runPromise(parseHostOperationResponse(response)),
    ).resolves.toEqual(response);
  });

  it("encodes plain dispatch carrier data and restores internal Option values", async () => {
    const base = {
      hostId: "demo",
      publicOrigin: "https://ptools.example",
      request: {
        operation: "mcp_auth_status" as const,
        input: { origin: "https://ptools.example" },
      },
    };
    const withCaller = HostOperationDispatchInput.make({
      ...base,
      caller: Option.some({ kind: "HostApiTokenCaller" }),
    });
    const withoutCaller = HostOperationDispatchInput.make({
      ...base,
      caller: Option.none(),
    });

    const encodedWithCaller = await Effect.runPromise(
      Schema.encode(HostOperationDispatchInput)(withCaller),
    );
    const encodedWithoutCaller = await Effect.runPromise(
      Schema.encode(HostOperationDispatchInput)(withoutCaller),
    );

    expect(encodedWithCaller).toMatchObject({
      hostId: "demo",
      caller: { kind: "HostApiTokenCaller" },
    });
    expect(encodedWithoutCaller).not.toHaveProperty("caller");

    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(HostOperationDispatchInput)(encodedWithCaller),
    );
    expect(Option.getOrThrow(decoded.caller)).toEqual({
      kind: "HostApiTokenCaller",
    });
  });

  it("decodes structured configure input", async () => {
    const request = await Effect.runPromise(
      parseHostOperationRequest({
        operation: "configure",
        input: {
          config: {
            mcpServers: {
              github: { url: "https://example.com/mcp" },
            },
          },
        },
      }),
    );

    expect(request.operation).toBe("configure");
  });

  it("decodes OAuth callback completion request and browser response payload", async () => {
    const request = await Effect.runPromise(
      parseHostOperationRequest({
        operation: "complete_mcp_oauth_callback",
        input: {
          origin: "https://ptools.example",
          provider: "github",
          method: "GET",
          url: "https://ptools.example/hosts/demo/oauth/callback/github?code=abc&state=xyz",
        },
      }),
    );

    expect(request.operation).toBe("complete_mcp_oauth_callback");

    const response: HostOperationResponse = {
      operation: "complete_mcp_oauth_callback",
      result: {
        ok: true,
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<p>Connected</p>",
        },
      },
    };

    await expect(
      Effect.runPromise(parseHostOperationResponse(response)),
    ).resolves.toEqual(response);
  });
});

describe("HostHttpOperationAdapterLive", () => {
  it("resolves the route host and forwards the complete normalized input", async () => {
    const request = searchRequest();
    const seen: {
      hostId?: string;
      input?: HostOperationDispatchInput;
    } = {};
    const response = HostCodeModeResponse.make({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: { actions: [], diagnostics: [] },
        },
      },
    });
    const discoveryLayer = Layer.succeed(HostInstanceDiscovery, {
      resolve: (hostId) =>
        Effect.sync(() => {
          seen.hostId = hostId;
          return {
            dispatch: (input: HostOperationDispatchInput) =>
              Effect.sync(() => {
                seen.input = input;
                return response;
              }),
          };
        }),
    });

    const result = await Effect.runPromise(
      Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
        adapter.codeMode({ path: { hostId: "demo" }, payload: request }),
      ).pipe(
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provideService(VerifiedHostApiCaller, {
          caller: { kind: "HostApiTokenCaller" },
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(Layer.provide(discoveryLayer)),
        ),
      ),
    );

    expect(result).toEqual(response);
    expect(seen.hostId).toBe("demo");
    expect(seen.input).toMatchObject({
      hostId: "demo",
      publicOrigin: "https://ptools.example",
      request: { operation: "code_mode", input: request },
    });
    expect(Option.isSome(seen.input?.caller ?? Option.none())).toBe(true);
  });

  it("maps discovery failures to the shared HTTP internal error", async () => {
    const discoveryLayer = Layer.succeed(HostInstanceDiscovery, {
      resolve: () =>
        Effect.fail(
          new HostOperationDispatchError({ message: "Instance unavailable" }),
        ),
    });

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(HostHttpOperationAdapter, (adapter) =>
        adapter.codeMode({
          path: { hostId: "demo" },
          payload: searchRequest(),
        }),
      ).pipe(
        Effect.provideService(HostHttpIngress, {
          publicOrigin: "https://ptools.example",
        }),
        Effect.provideService(VerifiedHostApiCaller, {
          caller: { kind: "HostApiTokenCaller" },
        }),
        Effect.provide(
          HostHttpOperationAdapterLive.pipe(Layer.provide(discoveryLayer)),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("Instance unavailable");
  });
});

describe("HostHttpClientLive", () => {
  it("requires a platform HttpClient layer instead of owning fetch directly", () => {
    const layer: Layer.Layer<HostHttpClient, never, HttpClient.HttpClient> =
      HostHttpClientLive({
        baseUrl: "https://ptools.example",
        hostId: "demo",
        accessToken: Redacted.make("token"),
      });

    expect(layer).toBeDefined();
  });

  it("builds codeMode HTTP requests with bearer auth and decodes the host envelope", async () => {
    const response: HostCodeModeResponse = {
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: { actions: [], diagnostics: [] },
        },
      },
    };
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://ptools.example/hosts/demo%20host/code-mode",
        );
        expect(request.headers.authorization).toBe("Bearer secret-token");
        expect(request.body._tag).toBe("Uint8Array");
        const bodyText = new TextDecoder().decode(
          request.body._tag === "Uint8Array" ? request.body.body : undefined,
        );
        expect(JSON.parse(bodyText)).toEqual({
          operation: "search",
          input: { query: "github" },
        });

        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HostHttpClient;
        return yield* client.codeMode(searchRequest());
      }).pipe(
        Effect.provide(
          HostHttpClientLive({
            baseUrl: "https://ptools.example",
            hostId: "demo host",
            accessToken: Redacted.make("secret-token"),
          }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        ),
      ),
    );

    expect(result).toEqual(response);
  });
});

describe("CodeModeClientFromHostHttpClientLive", () => {
  it("unwraps the code_mode host operation envelope for focused CodeModeClient callers", async () => {
    const host = Layer.succeed(
      HostHttpClient,
      makeHostHttpClient({
        operation: "code_mode",
        result: {
          ok: true,
          response: {
            operation: "search",
            output: { actions: [], diagnostics: [] },
          },
        },
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* CodeModeClient;
        return yield* client.call(searchRequest());
      }).pipe(
        Effect.provide(
          CodeModeClientFromHostHttpClientLive.pipe(Layer.provide(host)),
        ),
      ),
    );

    expect(result.operation).toBe("search");
  });

  it("maps invalid_code_mode_request into CodeModeInvalidRequestError", async () => {
    const result = await runCodeModeClientWithHostResponse({
      operation: "code_mode",
      result: {
        ok: false,
        error: {
          code: "invalid_code_mode_request",
          message: "Invalid Code Mode request.",
        },
      },
    });

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(CodeModeInvalidRequestError);
    }
  });

  it("maps code_mode_server_failure into CodeModeRemoteError", async () => {
    const result = await runCodeModeClientWithHostResponse({
      operation: "code_mode",
      result: {
        ok: false,
        error: {
          code: "code_mode_server_failure",
          message: "Code Mode server failed.",
        },
      },
    });

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(CodeModeRemoteError);
    }
  });
});

const runCodeModeClientWithHostResponse = (response: HostCodeModeResponse) => {
  const host = Layer.succeed(HostHttpClient, makeHostHttpClient(response));

  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* CodeModeClient;
      return yield* client.call(searchRequest()).pipe(Effect.either);
    }).pipe(
      Effect.provide(
        CodeModeClientFromHostHttpClientLive.pipe(Layer.provide(host)),
      ),
    ),
  );
};

const searchRequest = () => ({
  operation: "search" as const,
  input: CodeModeSearchRequest.make({
    query: "github",
    provider: Option.none(),
    limit: Option.none(),
  }),
});

const makeHostHttpClient = (response: HostCodeModeResponse) => ({
  codeMode: () => Effect.succeed(response),
  configure: () => Effect.die("unused"),
  configureSecrets: () => Effect.die("unused"),
  mcpAuthStatus: () => Effect.die("unused"),
  startMcpAuth: () => Effect.die("unused"),
});

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const tsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return tsFiles(path);
      }
      return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );

  return nested.flat();
};
