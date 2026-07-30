/**
 * Integration coverage for the configured-context lifecycle.
 *
 * These tests cover both cache selection and scoped-resource ownership. They
 * prove stable-key reuse, origin eviction, explicit invalidation, zero-TTL
 * failed builds, concurrent lookup deduplication, in-flight lease protection,
 * and exactly-once finalization when the owning runtime is disposed.
 */
import { AuthCoordinator } from "@ptools/auth";
import {
  ConfiguredHostConfigStore,
  HostSecretStorageBackend,
  HostStateStorageBackend,
  PtoolsConfig,
  ResolvedHttpMcpConfig,
  type HostStorageOperations,
} from "@ptools/config";
import { SandboxRuntime } from "@ptools/executor";
import { HostIdentity } from "@ptools/host-context";
import { McpConnector, type ConnectedMcpClient } from "@ptools/mcp-registry";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfiguredHostContextRunner,
  HostStableRuntimeLayer,
  type HostStableRuntimeServices,
} from "../src/index.js";

const runtimes: Array<
  ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>
> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("ConfiguredHostContextRunner", () => {
  it("reuses one origin context, replaces it for another origin, and invalidates it", async () => {
    const runtime = makeRuntime();
    await storeEmptyConfig(runtime);

    const first = await configuredAuth(runtime, "https://one.example");
    const reused = await configuredAuth(runtime, "https://one.example");
    const replaced = await configuredAuth(runtime, "https://two.example");

    expect(reused).toBe(first);
    expect(replaced).not.toBe(first);
    await expect(runtime.runPromise(replaced.status)).resolves.toMatchObject({
      authUrl: "https://two.example/hosts/demo/auth",
    });

    await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ConfiguredHostContextRunner;
        yield* runner.invalidateAll;
      }),
    );

    const rebuilt = await configuredAuth(runtime, "https://two.example");
    expect(rebuilt).not.toBe(replaced);
  });

  it("does not retain a failed configured-context build", async () => {
    const runtime = makeRuntime();

    await expect(
      configuredAuth(runtime, "https://one.example"),
    ).rejects.toThrow();

    // Write through the stable store without invalidating. A successful retry
    // proves the failed cache entry received the zero failure TTL.
    await storeEmptyConfig(runtime);

    await expect(
      configuredAuth(runtime, "https://one.example"),
    ).resolves.toBeDefined();
  });

  it("does not invalidate a healthy context when an operation fails", async () => {
    const connections = connectionTracker();
    const runtime = makeRuntime(connections);
    await storeHttpConfig(runtime);

    const beforeFailure = await configuredAuth(runtime, "https://one.example");
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ConfiguredHostContextRunner;
        return yield* runner
          .run(
            { origin: "https://one.example" },
            Effect.fail("operation failed"),
          )
          .pipe(Effect.result);
      }),
    );
    const afterFailure = await configuredAuth(runtime, "https://one.example");

    expect(result._tag).toBe("Failure");
    expect(afterFailure).toBe(beforeFailure);
    expect(connections.acquired).toEqual([1]);
  });

  it("keeps an invalidated context alive until its in-flight lease completes", async () => {
    const connections = connectionTracker();
    const runtime = makeRuntime(connections);
    await storeHttpConfig(runtime);

    await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ConfiguredHostContextRunner;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const operation = yield* Effect.forkChild(
          runner.run(
            { origin: "https://one.example" },
            Effect.gen(function* () {
              yield* AuthCoordinator;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );

        yield* Deferred.await(entered);
        yield* runner.invalidateAll;
        expect(connections.closed).toEqual([]);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(operation);
        expect(connections.closed).toEqual([1]);
      }),
    );
  });

  it("defers eviction finalization while the replaced origin is still leased", async () => {
    const connections = connectionTracker();
    const runtime = makeRuntime(connections);
    await storeHttpConfig(runtime);

    await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ConfiguredHostContextRunner;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const firstOrigin = yield* Effect.forkChild(
          runner.run(
            { origin: "https://one.example" },
            Effect.gen(function* () {
              yield* AuthCoordinator;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );

        yield* Deferred.await(entered);
        yield* runner.run({ origin: "https://two.example" }, AuthCoordinator);
        expect(connections.acquired).toEqual([1, 2]);
        expect(connections.closed).toEqual([]);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(firstOrigin);
        expect(connections.closed).toEqual([1]);
      }),
    );
  });

  it("deduplicates concurrent construction for the same origin", async () => {
    const connectStarted = await Effect.runPromise(Deferred.make<void>());
    const allowConnect = await Effect.runPromise(Deferred.make<void>());
    const connections = connectionTracker(
      Effect.andThen(
        Deferred.succeed(connectStarted, undefined),
        Deferred.await(allowConnect),
      ),
    );
    const runtime = makeRuntime(connections);
    await storeHttpConfig(runtime);

    await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ConfiguredHostContextRunner;
        const first = yield* Effect.forkChild(
          runner.run({ origin: "https://one.example" }, AuthCoordinator),
        );
        const second = yield* Effect.forkChild(
          runner.run({ origin: "https://one.example" }, AuthCoordinator),
        );

        yield* Deferred.await(connectStarted);
        expect(connections.acquired).toEqual([1]);
        yield* Deferred.succeed(allowConnect, undefined);
        const [firstService, secondService] = yield* Effect.all([
          Fiber.join(first),
          Fiber.join(second),
        ]);
        expect(secondService).toBe(firstService);
        expect(connections.acquired).toEqual([1]);
      }),
    );
  });

  it("finalizes the cached context exactly once when its stable runtime is disposed", async () => {
    const connections = connectionTracker();
    const runtime = makeRuntime(connections);
    await storeHttpConfig(runtime);
    await configuredAuth(runtime, "https://one.example");

    expect(connections.closed).toEqual([]);
    await runtime.dispose();
    removeRuntime(runtime);
    expect(connections.closed).toEqual([1]);

    await runtime.dispose();
    expect(connections.closed).toEqual([1]);
  });
});

const configuredAuth = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
  origin: string,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const runner = yield* ConfiguredHostContextRunner;

      return yield* runner.run({ origin }, AuthCoordinator);
    }),
  );

const storeEmptyConfig = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
) => storeConfig(runtime, {});

const storeHttpConfig = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
) =>
  storeConfig(runtime, {
    fixture: ResolvedHttpMcpConfig.make({
      url: "https://fixture.example/mcp",
      headers: Option.none(),
      auth: Option.none(),
    }),
  });

const storeConfig = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
  mcpServers: PtoolsConfig["mcpServers"],
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* ConfiguredHostConfigStore;
      yield* store.replace({
        config: PtoolsConfig.make({
          mcpServers,
          executor: Option.none(),
        }),
      });
    }),
  );

interface ConnectionTracker {
  readonly acquired: number[];
  readonly closed: number[];
  readonly beforeConnect: Effect.Effect<void>;
}

const connectionTracker = (
  beforeConnect: Effect.Effect<void> = Effect.void,
): ConnectionTracker => ({ acquired: [], closed: [], beforeConnect });

const makeRuntime = (
  connections?: ConnectionTracker,
): ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown> => {
  const state = memoryStorage();
  const secret = memoryStorage();
  const primitiveLayer = Layer.mergeAll(
    Layer.succeed(HostStateStorageBackend, {
      forHost: () => Effect.succeed(state),
    }),
    Layer.succeed(HostSecretStorageBackend, {
      forHost: () => Effect.succeed(secret),
    }),
    Layer.succeed(HostIdentity, { hostId: "demo" }),
    Layer.succeed(McpConnector, {
      connect: (input) =>
        connections === undefined
          ? Effect.die("No MCP servers are configured in this test.")
          : Effect.gen(function* () {
              const connectionId = connections.acquired.length + 1;
              connections.acquired.push(connectionId);
              yield* connections.beforeConnect;
              return {
                serverName: input.serverName,
                jsServerName: input.jsServerName,
                client: {
                  listTools: async () => ({ tools: [] }),
                  close: async () => {
                    connections.closed.push(connectionId);
                  },
                },
              } as unknown as ConnectedMcpClient;
            }),
    }),
    Layer.succeed(SandboxRuntime, {
      execute: () => Effect.die("The sandbox is not used in this test."),
    }),
  );
  const runtime = ManagedRuntime.make(
    HostStableRuntimeLayer({ supportsStdioMcp: true }).pipe(
      Layer.provide(primitiveLayer),
    ),
  );

  runtimes.push(runtime);
  return runtime;
};

const removeRuntime = (
  runtime: ManagedRuntime.ManagedRuntime<HostStableRuntimeServices, unknown>,
): void => {
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
};

const memoryStorage = (): HostStorageOperations => {
  const values = new Map<string, string>();

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
