import {
  HostSecretStorageBackend,
  HostStateStorageBackend,
  type HostStorageOperations,
} from "@ptools/config";
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { SandboxRuntime } from "@ptools/executor";
import {
  HostOperationProtocolFailureResponse,
  type HostOperationDispatchInput,
  type HostOperationRequest,
} from "@ptools/host-api";
import {
  McpConnector,
  type ConnectedMcpClient,
  type ConnectMcpInput,
} from "@ptools/mcp-registry";
import { Deferred, Effect, Fiber, Result, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeNodeHostActorRuntimeFromPlatformLayers,
  type NodeHostActorRuntime,
} from "../src/hostActorDaemon/actorRuntime/nodeHostActorRuntime.js";
import {
  NodeHostActorRuntimeError,
  NodeHostActorRuntimePhase,
} from "../src/hostActorDaemon/actorRuntime/nodeHostActorRuntimeError.js";
import {
  NodeDaemonHostActorRuntimeActivator,
  type NodeDaemonHostActorRuntimeActivatorOperations,
} from "../src/hostActorDaemon/actorRuntime/services/nodeDaemonHostActorRuntimeActivator.js";
import { makeNodeHostRuntimeManager } from "../src/hostActorDaemon/actorRuntime/services/nodeHostRuntimeManager.js";

const origin = "https://ptools.example";

describe("NodeHostRuntimeManager", () => {
  it("reuses one active runtime for repeated dispatch to one host", async () => {
    let activations = 0;
    let dispatches = 0;
    const runtime = fakeRuntime("host-a", {
      onDispatch: () => dispatches++,
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeTestManager({
            activate: (hostId) =>
              Effect.sync(() => {
                activations++;
                expect(hostId).toBe("host-a");
                return runtime;
              }),
          });
          yield* manager.dispatch(inputFor("host-a"));
          yield* manager.dispatch(inputFor("host-a"));
        }),
      ),
    );

    expect(activations).toBe(1);
    expect(dispatches).toBe(2);
  });

  it("publishes one runtime for concurrent first dispatches", async () => {
    let activations = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const activationStarted = yield* Deferred.make<void>();
          const releaseActivation = yield* Deferred.make<void>();
          const manager = yield* makeTestManager({
            activate: (hostId) =>
              Effect.gen(function* () {
                activations++;
                yield* Deferred.succeed(activationStarted, undefined);
                yield* Deferred.await(releaseActivation);
                return fakeRuntime(hostId);
              }),
          });

          const first = yield* Effect.forkChild(
            manager.dispatch(inputFor("host-a")),
          );
          yield* Deferred.await(activationStarted);
          const second = yield* Effect.forkChild(
            manager.dispatch(inputFor("host-a")),
          );
          yield* Deferred.succeed(releaseActivation, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      ),
    );

    expect(activations).toBe(1);
  });

  it("activates different host IDs concurrently", async () => {
    const started = new Set<string>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bothStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const manager = yield* makeTestManager({
            activate: (hostId) =>
              Effect.gen(function* () {
                yield* Effect.sync(() => {
                  started.add(hostId);
                });
                if (started.size === 2) {
                  yield* Deferred.succeed(bothStarted, undefined);
                }
                yield* Deferred.await(release);
                return fakeRuntime(hostId);
              }),
          });

          const hostA = yield* Effect.forkChild(
            manager.dispatch(inputFor("host-a")),
          );
          const hostB = yield* Effect.forkChild(
            manager.dispatch(inputFor("host-b")),
          );
          yield* Deferred.await(bothStarted);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(hostA);
          yield* Fiber.join(hostB);
        }),
      ),
    );

    expect(started).toEqual(new Set(["host-a", "host-b"]));
  });

  it("removes a failed activation so a later dispatch can retry", async () => {
    let attempts = 0;

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeTestManager({
            activate: (hostId) =>
              Effect.suspend(() => {
                attempts++;
                return attempts === 1
                  ? Effect.fail(runtimeError(hostId, "activation failed"))
                  : Effect.succeed(fakeRuntime(hostId));
              }),
          });

          const first = yield* manager
            .dispatch(inputFor("host-a"))
            .pipe(Effect.result);
          const second = yield* manager
            .dispatch(inputFor("host-a"))
            .pipe(Effect.result);
          return { first, second };
        }),
      ),
    );

    expect(Result.isFailure(results.first)).toBe(true);
    expect(Result.isSuccess(results.second)).toBe(true);
    expect(attempts).toBe(2);
  });

  it("disposes every active runtime when the manager scope closes", async () => {
    const disposed: string[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeTestManager({
            activate: (hostId) =>
              Effect.succeed(
                fakeRuntime(hostId, {
                  onDispose: () => disposed.push(hostId),
                  failDispose: hostId === "host-a",
                }),
              ),
          });
          yield* manager.dispatch(inputFor("host-a"));
          yield* manager.dispatch(inputFor("host-b"));
        }),
      ),
    );

    expect(disposed.sort()).toEqual(["host-a", "host-b"]);
  });

  it("does not retain a raw Runtime that can dispatch after disposal", async () => {
    const actorHarness = makeInMemoryActorPlatformHarness();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* actorHarness.runtimeFor("host-a");
        yield* runtime.dispose;
        return yield* runtime.dispatch(inputFor("host-a")).pipe(Effect.result);
      }),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.phase).toBe(NodeHostActorRuntimePhase.Execute);
    }
  });

  it("uses shared handler semantics, isolated stores, and origin-aware configured contexts", async () => {
    const actorHarness = makeInMemoryActorPlatformHarness();
    const activations: string[] = [];
    // The runtime manager starts after carrier decoding. Build the decoded DTO
    // during setup rather than making decoding appear to be manager behavior.
    const config = decodeUserConfigForTest({
      fixture: { url: "https://fixture.example/mcp" },
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeTestManager({
            activate: (hostId) =>
              makeNodeHostActorRuntimeFromPlatformLayers(
                hostId,
                actorHarness.layers,
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    activations.push(hostId);
                  }),
                ),
              ),
          });

          const configuredA = yield* manager.dispatch(
            inputFor("host-a", {
              operation: "configure",
              input: { config },
            }),
          );
          const secretsA = yield* manager.dispatch(
            inputFor("host-a", {
              operation: "configure_secrets",
              input: { secrets: { TOKEN: "alpha" } },
            }),
          );
          yield* manager.dispatch(
            inputFor("host-b", {
              operation: "configure",
              input: { config },
            }),
          );
          yield* manager.dispatch(
            inputFor("host-b", {
              operation: "configure_secrets",
              input: { secrets: { TOKEN: "beta" } },
            }),
          );

          // Drive repeated host-a code_mode traffic after activation. These
          // calls are not asserted by return value; later checks use them to
          // prove (1) the manager reuses one Active runtime (activations stay
          // ["host-a","host-b"]) and (2) configured MCP context is origin-aware:
          // same publicOrigin reuses a connection, a different origin rebuilds
          // and connects again (fixture connections length === 2, not 1 or 3).
          yield* manager.dispatch(codeModeSearch("host-a", origin));
          yield* manager.dispatch(codeModeSearch("host-a", origin));
          yield* manager.dispatch(
            codeModeSearch("host-a", "https://other.example"),
          );

          const mismatch = yield* Effect.acquireUseRelease(
            actorHarness.runtimeFor("host-a"),
            (runtime) => runtime.dispatch(inputFor("wrong-receiver")),
            (runtime) => runtime.dispose.pipe(Effect.orDie),
          );

          expect(configuredA).toMatchObject({
            operation: "configure",
            result: { ok: true, hostId: "host-a" },
          });
          expect(secretsA).toMatchObject({
            operation: "configure_secrets",
            result: { ok: true, hostId: "host-a" },
          });
          expect(mismatch).toMatchObject({
            error: { code: "host_unavailable" },
          });
        }),
      ),
    );

    // Still one activate per host despite the repeated host-a dispatches above.
    expect(activations.sort()).toEqual(["host-a", "host-b"]);
    expect(actorHarness.stateByHost.has("host-a")).toBe(true);
    expect(actorHarness.stateByHost.has("host-b")).toBe(true);
    expect(
      Array.from(actorHarness.secretsByHost.get("host-a")?.values() ?? []),
    ).toContain("alpha");
    expect(
      Array.from(actorHarness.secretsByHost.get("host-b")?.values() ?? []),
    ).toContain("beta");
    // Two host-a code_mode searches shared one origin (one connect); the third
    // used a different origin (second connect). Not three connects.
    expect(
      actorHarness.connections.filter(
        ({ serverName }) => serverName === "fixture",
      ),
    ).toHaveLength(2);
  });
});

/** Construct the decoded config value that the HTTP boundary normally supplies. */
const decodeUserConfigForTest = (mcpServers: Record<string, unknown>) =>
  Schema.decodeUnknownSync(UserPtoolsConfig)({ mcpServers });

const makeTestManager = (
  runtimeActivator: NodeDaemonHostActorRuntimeActivatorOperations,
) =>
  makeNodeHostRuntimeManager.pipe(
    Effect.provideService(
      NodeDaemonHostActorRuntimeActivator,
      NodeDaemonHostActorRuntimeActivator.of(runtimeActivator),
    ),
  );

const inputFor = (
  hostId: string,
  request: HostOperationRequest = {
    operation: "configure_secrets",
    input: { secrets: {} },
  },
): HostOperationDispatchInput => ({
  hostId,
  publicOrigin: origin,
  caller: Option.none(),
  request,
});

const codeModeSearch = (
  hostId: string,
  publicOrigin: string,
): HostOperationDispatchInput => ({
  ...inputFor(hostId, {
    operation: "code_mode",
    input: { operation: "search_providers" },
  }),
  publicOrigin,
});

const fakeRuntime = (
  hostId: string,
  options: {
    readonly onDispatch?: () => void;
    readonly onDispose?: () => void;
    readonly failDispose?: boolean;
  } = {},
): NodeHostActorRuntime => ({
  hostId,
  dispatch: () =>
    Effect.sync(() => {
      options.onDispatch?.();
      return HostOperationProtocolFailureResponse.make({
        error: { code: "host_unavailable", message: "fixture" },
      });
    }),
  dispose: Effect.suspend(() => {
    options.onDispose?.();
    return options.failDispose === true
      ? Effect.fail(
          runtimeError(
            hostId,
            "dispose failed",
            NodeHostActorRuntimePhase.Dispose,
          ),
        )
      : Effect.void;
  }),
});

const runtimeError = (
  hostId: string,
  message: string,
  phase: NodeHostActorRuntimePhase = NodeHostActorRuntimePhase.Activate,
) => new NodeHostActorRuntimeError({ hostId, phase, message });

/**
 * Build real shared actor runtimes over observable in-memory implementations of
 * the four abstract platform ports. This component-test harness is used where
 * assertions need deterministic storage/connection visibility; the separate
 * integration suite uses production Node filesystem, MCP, and Deno adapters.
 */
const makeInMemoryActorPlatformHarness = () => {
  const stateByHost = new Map<string, Map<string, string>>();
  const secretsByHost = new Map<string, Map<string, string>>();
  const connections: ConnectMcpInput[] = [];

  const layers = {
    stateStorageBackend: Layer.succeed(HostStateStorageBackend, {
      forHost: (hostId) => Effect.sync(() => storageFor(stateByHost, hostId)),
    }),
    secretStorageBackend: Layer.succeed(HostSecretStorageBackend, {
      forHost: (hostId) => Effect.sync(() => storageFor(secretsByHost, hostId)),
    }),
    mcpConnector: Layer.succeed(McpConnector, {
      connect: (input) =>
        Effect.sync(() => {
          connections.push(input);
          return connectedClient(input);
        }),
    }),
    sandboxRuntime: Layer.succeed(SandboxRuntime, {
      execute: () =>
        Effect.die(new Error("Sandbox execution is not used here.")),
    }),
  };

  return {
    layers,
    stateByHost,
    secretsByHost,
    connections,
    runtimeFor: (hostId: string) =>
      makeNodeHostActorRuntimeFromPlatformLayers(hostId, layers),
  };
};

const storageFor = (
  stores: Map<string, Map<string, string>>,
  hostId: string,
): HostStorageOperations => {
  const values = stores.get(hostId) ?? new Map<string, string>();
  stores.set(hostId, values);
  return {
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    put: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    delete: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  };
};

const connectedClient = (input: ConnectMcpInput): ConnectedMcpClient =>
  ({
    serverName: input.serverName,
    jsServerName: input.jsServerName,
    client: {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "Echo fixture",
            inputSchema: { type: "object" },
          },
        ],
      }),
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    },
  }) as unknown as ConnectedMcpClient;
