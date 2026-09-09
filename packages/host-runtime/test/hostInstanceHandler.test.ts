/**
 * Focused behavior contract for the receiver-side host operation seam.
 *
 * These tests build the real shared stable runtime over in-memory platform
 * primitives. They intentionally assert public behavior—not private cache
 * identity: replacement config changes the providers visible to Code Mode,
 * rotated secrets change the resolved values delivered to the MCP connector,
 * rejected config leaves the previous host behavior intact, and storage
 * failures become the documented operation response. Detailed MCP, Code Mode,
 * OAuth, and storage algorithms remain covered by their owning packages.
 */
import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
  HostStorageError,
  type HostStorageOperations,
} from "@ptools/config";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { SandboxRuntime } from "@ptools/executor";
import {
  injectableBindingKeys,
  makeSandboxKernel,
  type SandboxProgram,
} from "@ptools/executor/sandbox";
import { HostIdentity } from "@ptools/host-context";
import {
  CodeModeExecuteRequest,
  CodeModeSearchRequest,
} from "@ptools/code-mode-api";
import type {
  HostOperationDispatchInput,
  HostOperationRequest,
} from "@ptools/host-api";
import {
  McpConnector,
  type ConnectMcpInput,
  type ConnectedMcpClient,
} from "@ptools/mcp-registry";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostInstanceHandler,
  HostStableRuntimeLayer,
  type HostStableRuntimeServices,
} from "../src/index.js";

const runtimes: Array<
  ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>
> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("HostInstanceHandler", () => {
  /**
   * The receiver repeats the caller-side host check because a remote carrier is
   * a trust boundary. A mismatched operation must not touch this host's stores
   * or configured runtime.
   */
  it("rejects an operation addressed to a different host", async () => {
    const response = await dispatch(makeRuntime(true), "other", {
      operation: "mcp_auth_status",
    });

    expect(response).toMatchObject({
      _tag: "HostOperationProtocolFailureResponse",
      error: { code: "host_unavailable" },
    });
  });

  /**
   * This exercises the observable reason configure invalidates the cache—not an
   * internal object identity. The first Code Mode request connects only the
   * `alpha` server. After replacement, the next request must rebuild from the
   * persisted config, connect only `beta`, and expose only `beta` to callers.
   * Reusing the stale configured Context would leave `alpha` visible and would
   * never call the connector for `beta`.
   */
  it("publishes replacement config to the next configured operation", async () => {
    const connections: ConnectMcpInput[] = [];
    const runtime = makeRuntime(true, connections);
    await configure(runtime, {
      alpha: { url: "https://alpha.example/mcp" },
    });

    expect(await searchProviders(runtime)).toEqual(["alpha"]);
    expect(connections.map(({ serverName }) => serverName)).toEqual(["alpha"]);

    const response = await configure(runtime, {
      beta: { url: "https://beta.example/mcp" },
    });

    expect(response).toMatchObject({
      operation: "configure",
      result: { ok: true, configured: true, hostId: "demo", serverCount: 1 },
    });
    expect(await searchProviders(runtime)).toEqual(["beta"]);
    expect(connections.map(({ serverName }) => serverName)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  /**
   * `supportsStdioMcp` is configure-time admission policy. Rejection must happen
   * before persistence, while an enabled host must store the same valid config.
   */
  it("rejects stdio before persistence when disabled and accepts it when enabled", async () => {
    const disabledConnections: ConnectMcpInput[] = [];
    const disabled = makeRuntime(false, disabledConnections);
    await configure(disabled, {
      remote: { url: "https://remote.example/mcp" },
    });
    expect(await searchProviders(disabled)).toEqual(["remote"]);

    const rejected = await configure(disabled, {
      local: { command: "node", args: ["server.js"], cwd: "../app" },
    });
    expect(rejected).toMatchObject({
      operation: "configure",
      result: { ok: false, error: { code: "unsupported_config" } },
    });
    // Rejection happened before persistence/invalidation: the previously valid
    // remote config remains authoritative and no stdio connection is attempted.
    expect(await searchProviders(disabled)).toEqual(["remote"]);
    expect(disabledConnections.map(({ serverName }) => serverName)).toEqual([
      "remote",
    ]);

    const enabled = makeRuntime(true);
    const accepted = await configure(enabled, {
      local: { command: "node", args: ["server.js"] },
    });
    expect(accepted).toMatchObject({
      operation: "configure",
      result: { ok: true, serverCount: 1 },
    });
  });

  /**
   * Host API config has no source-file directory from which to resolve a
   * relative stdio cwd. Admission rejects it before persistence/invalidation,
   * while portable POSIX and Windows absolute paths remain valid regardless of
   * the operating system running this shared test.
   */
  it("rejects relative stdio cwd before persistence and accepts portable absolute cwd", async () => {
    const connections: ConnectMcpInput[] = [];
    const runtime = makeRuntime(true, connections);
    await configure(runtime, {
      remote: { url: "https://remote.example/mcp" },
    });
    expect(await searchProviders(runtime)).toEqual(["remote"]);

    for (const cwd of ["./app", "../app"]) {
      const rejected = await configure(runtime, {
        "local-tools": { command: "node", cwd },
      });
      expect(rejected).toMatchObject({
        operation: "configure",
        result: {
          ok: false,
          error: {
            code: "invalid_config",
            message: `MCP server "local-tools" uses relative stdio cwd "${cwd}". Host API configuration has no source config file directory, so stdio cwd must be absolute or omitted.`,
          },
        },
      });
      // Rejection neither persisted the invalid config nor invalidated the
      // already-built configured Context.
      expect(await searchProviders(runtime)).toEqual(["remote"]);
    }
    expect(connections.map(({ serverName }) => serverName)).toEqual(["remote"]);

    for (const cwd of ["/srv/local-tools", "C:\\tools\\local-tools"]) {
      const accepted = await configure(makeRuntime(true), {
        "local-tools": { command: "node", cwd },
      });
      expect(accepted).toMatchObject({
        operation: "configure",
        result: { ok: true, serverCount: 1 },
      });
    }
  });

  /**
   * Secret replacement must rebuild config-derived services too. The connector
   * records the fully resolved HTTP headers it receives: after rotation, the
   * next configured operation must receive `new-token`, not the value captured
   * by the previous Context.
   */
  it("publishes rotated secrets to the next configured operation", async () => {
    const connections: ConnectMcpInput[] = [];
    const runtime = makeRuntime(true, connections);
    await configureSecrets(runtime, { TOKEN: "old-token" });
    await configure(runtime, {
      remote: {
        url: "https://remote.example/mcp",
        headers: { Authorization: "Bearer ${env:TOKEN}" },
      },
    });

    await searchProviders(runtime);
    expect(resolvedAuthorization(connections[0])).toBe("Bearer old-token");

    const response = await configureSecrets(runtime, { TOKEN: "new-token" });
    await searchProviders(runtime);

    expect(response).toMatchObject({
      operation: "configure_secrets",
      result: { ok: true, configured: true, secretCount: 1 },
    });
    expect(resolvedAuthorization(connections[1])).toBe("Bearer new-token");
  });

  /**
   * Persistence failures stay operation-owned response values. They must not
   * escape as carrier failures, because discovery/RPC succeeded and only this
   * selected host's backing store was unavailable.
   */
  it("maps config and secret storage failures to their public responses", async () => {
    const configFailure = makeRuntime(true, [], { failStatePuts: true });
    await expect(configure(configFailure, {})).resolves.toMatchObject({
      operation: "configure",
      result: { ok: false, error: { code: "config_storage_unavailable" } },
    });

    const secretFailure = makeRuntime(true, [], { failSecretPuts: true });
    await expect(
      configureSecrets(secretFailure, { TOKEN: "secret" }),
    ).resolves.toMatchObject({
      operation: "configure_secrets",
      result: { ok: false, error: { code: "secrets_storage_unavailable" } },
    });
  });

  /**
   * Exercise discovery and search through the complete shared stack. The fake
   * platform connector contributes one real MCP tool; the real registry and
   * Code Mode implementation must turn it into provider metadata and a
   * searchable action before the handler wraps the result.
   */
  it("discovers and searches configured MCP tools through Code Mode", async () => {
    const runtime = makeRuntime(true);
    await configure(runtime, {
      fixture: { url: "https://fixture.example/mcp" },
    });

    const providers = await dispatch(runtime, "demo", {
      operation: "code_mode",
      input: { operation: "search_providers" },
    });
    expect(providers).toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search_providers",
          output: {
            providers: [
              { provider: "fixture", displayName: "fixture", toolCount: 1 },
            ],
            diagnostics: [],
          },
        },
      },
    });

    const search = await dispatch(runtime, "demo", {
      operation: "code_mode",
      input: {
        operation: "search",
        input: CodeModeSearchRequest.make({
          query: "echo",
          provider: Option.none(),
          limit: Option.none(),
        }),
      },
    });
    expect(search).toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "search",
          output: {
            actions: [
              {
                toolId: "fixture.echo",
                provider: "fixture",
                action: "echo",
                inputFields: ["text"],
              },
            ],
            diagnostics: [],
          },
        },
      },
    });
  });

  /**
   * Exercise generated-code execution rather than merely checking operation
   * discriminators. The real executor and sandbox kernel invoke `fixture.echo`
   * through the fake MCP client; the final value and captured log must survive
   * every layer and appear in the handler's public response.
   */
  it("executes generated code through the configured MCP provider", async () => {
    const runtime = makeRuntime(true);
    await configure(runtime, {
      fixture: { url: "https://fixture.example/mcp" },
    });

    const response = await dispatch(runtime, "demo", {
      operation: "code_mode",
      input: {
        operation: "execute",
        input: CodeModeExecuteRequest.make({
          code: `async () => {
            console.log("calling fixture echo");
            return await fixture.echo({ text: "hello" });
          }`,
          timeoutMs: Option.none(),
        }),
      },
    });

    expect(response).toMatchObject({
      operation: "code_mode",
      result: {
        ok: true,
        response: {
          operation: "execute",
          output: {
            value: { text: "hello" },
            logs: [{ level: "log", message: "calling fixture echo" }],
            warnings: [],
          },
        },
      },
    });
  });

  /**
   * Run the successful OAuth browser round trip through the shared provider and
   * host stores. The fixture is only the external authorization server: state
   * signing/consumption, configured flow selection, callback parsing, and the
   * public browser response are real host-runtime behavior. State signature,
   * host/provider binding, expiry, and single-use storage also have direct
   * @ptools/auth tests; this test proves the handler uses that flow correctly.
   */
  it("starts OAuth, sends the expected OAuth request, and consumes callback state once", async () => {
    const tokenRequests: string[] = [];
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        requestedUrls.push(url.href);
        if (url.pathname.includes("oauth-protected-resource")) {
          return Response.json({
            resource: "https://fixture.example/mcp",
            authorization_servers: ["https://auth.fixture.example"],
          });
        }
        if (url.pathname.includes("oauth-authorization-server")) {
          return Response.json({
            issuer: "https://auth.fixture.example",
            authorization_endpoint: "https://auth.fixture.example/authorize",
            token_endpoint: "https://auth.fixture.example/token",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url.pathname === "/token") {
          tokenRequests.push(String(init?.body));
          return Response.json({
            access_token: "fixture-access-token",
            token_type: "Bearer",
          });
        }
        throw new Error(`Unexpected OAuth fixture request: ${url.href}`);
      },
    );

    const runtime = makeRuntime(true);
    await configure(runtime, {
      fixture: {
        url: "https://fixture.example/mcp",
        auth: { type: "oauth", clientId: "fixture-client" },
      },
    });

    const started = await dispatch(runtime, "demo", {
      operation: "start_mcp_auth",
      input: { serverName: "fixture", force: true },
    });
    if (
      !("operation" in started) ||
      started.operation !== "start_mcp_auth" ||
      !started.result.ok
    ) {
      throw new Error(
        `OAuth did not start: ${JSON.stringify(started)}; requests=${JSON.stringify(requestedUrls)}`,
      );
    }
    const authorizeUrl = new URL(started.result.authorizeUrl);
    const state = authorizeUrl.searchParams.get("state");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://auth.fixture.example/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("fixture-client");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `${origin}/hosts/demo/oauth/callback/fixture`,
    );
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(state).toBeTruthy();
    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/.well-known/oauth-protected-resource"),
        expect.stringContaining("/.well-known/oauth-authorization-server"),
      ]),
    );

    const callbackRequest = {
      operation: "complete_mcp_oauth_callback" as const,
      input: {
        origin,
        provider: "fixture",
        method: "GET",
        url: `${origin}/hosts/demo/oauth/callback/fixture?code=fixture-code&state=${encodeURIComponent(state ?? "")}`,
      },
    };
    const completed = await dispatch(runtime, "demo", callbackRequest);
    expect(completed).toMatchObject({
      operation: "complete_mcp_oauth_callback",
      result: {
        ok: true,
        response: {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      },
    });
    expect(tokenRequests).toHaveLength(1);
    const tokenRequest = new URLSearchParams(tokenRequests[0]);
    expect(tokenRequest.get("code")).toBe("fixture-code");
    expect(tokenRequest.get("grant_type")).toBe("authorization_code");
    expect(tokenRequest.get("redirect_uri")).toBe(
      `${origin}/hosts/demo/oauth/callback/fixture`,
    );
    expect(tokenRequest.get("code_verifier")).toBeTruthy();

    // State is consumed before token exchange; replay must fail and must not
    // issue a second token request.
    await expect(
      dispatch(runtime, "demo", callbackRequest),
    ).resolves.toMatchObject({
      operation: "complete_mcp_oauth_callback",
      result: { ok: false, error: { code: "invalid_oauth_callback" } },
    });
    expect(tokenRequests).toHaveLength(1);
  });

  /**
   * Exercise the auth-facing branches with a configured server. Status must
   * describe that server, while unsupported start and malformed callback input
   * must produce their exact public error categories instead of throwing out of
   * the handler as transport failures.
   */
  it("reports configured auth state and projects OAuth failures", async () => {
    const runtime = makeRuntime(true);
    await configure(runtime, {
      fixture: { url: "https://fixture.example/mcp" },
    });

    await expect(
      dispatch(runtime, "demo", {
        operation: "mcp_auth_status",
      }),
    ).resolves.toMatchObject({
      operation: "mcp_auth_status",
      result: {
        ok: true,
        status: {
          authUrl: `${origin}/hosts/demo/auth`,
          servers: [
            { serverName: "fixture", transport: "http", status: "connected" },
          ],
        },
      },
    });

    await expect(
      dispatch(runtime, "demo", {
        operation: "start_mcp_auth",
        input: { serverName: "missing", force: false },
      }),
    ).resolves.toMatchObject({
      operation: "start_mcp_auth",
      result: { ok: false, error: { code: "auth_unavailable" } },
    });

    await expect(
      dispatch(runtime, "demo", {
        operation: "complete_mcp_oauth_callback",
        input: {
          origin,
          provider: "missing",
          method: "GET",
          url: `${origin}/hosts/demo/oauth/callback/missing`,
        },
      }),
    ).resolves.toMatchObject({
      operation: "complete_mcp_oauth_callback",
      result: {
        ok: false,
        error: {
          code: "invalid_oauth_callback",
          message: "Missing OAuth state",
        },
      },
    });
  });
});

const origin = "https://ptools.example";

const dispatch = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
  hostId: string,
  request: HostOperationRequest,
) =>
  runtime.runPromise(
    Effect.flatMap(HostInstanceHandler, (handler) =>
      handler.handle({
        hostId,
        publicOrigin: origin,
        request,
      } satisfies HostOperationDispatchInput),
    ),
  );

const configure = async (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
  mcpServers: Record<string, unknown>,
) => {
  const config = await Effect.runPromise(
    Schema.decodeUnknownEffect(UserPtoolsConfig)(
      { mcpServers },
      {
        errors: "all",
        onExcessProperty: "error",
      },
    ),
  );
  return dispatch(runtime, "demo", {
    operation: "configure",
    input: { config },
  });
};

const configureSecrets = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
  secrets: Record<string, string>,
) =>
  dispatch(runtime, "demo", {
    operation: "configure_secrets",
    input: { secrets },
  });

/** Run the public Code Mode search and return the provider names callers see. */
const searchProviders = async (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
): Promise<ReadonlyArray<string>> => {
  const response = await dispatch(runtime, "demo", {
    operation: "code_mode",
    input: { operation: "search_providers" },
  });
  if (
    !("operation" in response) ||
    response.operation !== "code_mode" ||
    !response.result.ok ||
    response.result.response.operation !== "search_providers"
  ) {
    throw new Error("Expected a successful search_providers response.");
  }
  return response.result.response.output.providers.map(
    ({ provider }) => provider,
  );
};

/** Read the resolved authorization header passed to the platform connector. */
const resolvedAuthorization = (connection: ConnectMcpInput | undefined) => {
  if (connection === undefined || connection.config.transport !== "http") {
    throw new Error("Expected a recorded HTTP MCP connection.");
  }
  return Option.getOrThrow(connection.config.headers).Authorization;
};

const makeRuntime = (
  supportsStdioMcp: boolean,
  connections: ConnectMcpInput[] = [],
  failures: {
    readonly failStatePuts?: boolean;
    readonly failSecretPuts?: boolean;
  } = {},
): ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown> => {
  const state = memoryStorage("state", failures.failStatePuts === true);
  const secrets = memoryStorage("secret", failures.failSecretPuts === true);
  const primitives = Layer.mergeAll(
    Layer.succeed(HostStateStorageBackend, {
      forHost: () => Effect.succeed(state),
    }),
    Layer.succeed(HostSecretStorageBackend, {
      forHost: () => Effect.succeed(secrets),
    }),
    Layer.succeed(HostIdentity, { hostId: "demo" }),
    Layer.succeed(McpConnector, {
      connect: (input) =>
        Effect.sync(() => {
          connections.push(input);
          return {
            serverName: input.serverName,
            jsServerName: input.jsServerName,
            client: {
              listTools: async () => ({
                tools: [
                  {
                    name: "echo",
                    title: "Echo",
                    description: "Echo fixture",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                      required: ["text"],
                    },
                  },
                ],
              }),
              callTool: async (request: {
                readonly name: string;
                readonly arguments?: Record<string, unknown>;
              }) => ({
                content: [
                  { type: "text", text: String(request.arguments?.text) },
                ],
                structuredContent: { text: request.arguments?.text },
              }),
              close: async () => undefined,
            },
          } as unknown as ConnectedMcpClient;
        }),
    }),
    Layer.succeed(SandboxRuntime, {
      execute: (execution) =>
        Effect.promise(() => {
          const bindingKeys = injectableBindingKeys(
            execution.payload.globals,
            execution.payload.providers,
          );
          return makeSandboxKernel({
            invokeProvider: (call) =>
              Effect.runPromise(execution.handleProviderCall(call)),
          }).execute({
            program: loadProgram(execution.payload.code, bindingKeys),
            bindingKeys,
            globals: execution.payload.globals,
            providers: execution.payload.providers,
          });
        }),
    }),
  );
  const runtime = ManagedRuntime.make(
    HostStableRuntimeLayer({ supportsStdioMcp }).pipe(
      Layer.provide(primitives),
    ),
  );
  runtimes.push(runtime);
  return runtime;
};

const loadProgram = (
  code: string,
  names: ReadonlyArray<string>,
): SandboxProgram =>
  new Function(
    "__bindings",
    `const { ${names.join(", ")} } = __bindings; return (${code})();`,
  ) as SandboxProgram;

const memoryStorage = (
  storage: "state" | "secret",
  failPuts = false,
): HostStorageOperations => {
  const values = new Map<string, string>();
  return {
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    put: (key, value) =>
      failPuts
        ? Effect.fail(
            new HostStorageError({
              storage,
              operation: "put",
              key,
              cause: new Error("Fixture storage unavailable"),
            }),
          )
        : Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => void values.delete(key)),
  };
};
