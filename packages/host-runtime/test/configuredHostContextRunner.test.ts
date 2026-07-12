/**
 * Integration coverage for the configured-context lifecycle.
 *
 * These tests intentionally use fresh `{ origin }` objects to prove stable-key
 * reuse, compare service identities to prove origin eviction/invalidation, and
 * write config after a failed build to prove failures are not retained.
 */
import { AuthCoordinator } from "@ptools/auth";
import {
  ConfiguredHostConfigStore,
  HostSecretStorageBackend,
  HostStateStorageBackend,
  PtoolsConfig,
  type HostStorageOperations,
} from "@ptools/config";
import { SandboxRuntime } from "@ptools/executor";
import { HostIdentity } from "@ptools/host-context";
import { McpConnector } from "@ptools/mcp-registry";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
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

describe.sequential("ConfiguredHostContextRunner", () => {
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
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* ConfiguredHostConfigStore;
      yield* store.replace({
        config: PtoolsConfig.make({
          mcpServers: {},
          executor: Option.none(),
        }),
      });
    }),
  );

const makeRuntime = (): ManagedRuntime.ManagedRuntime<
  HostStableRuntimeServices,
  unknown
> => {
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
      connect: () => Effect.die("No MCP servers are configured in this test."),
    }),
    Layer.succeed(SandboxRuntime, {
      execute: () => Effect.die("The sandbox is not used in this test."),
    }),
  );
  const runtime = ManagedRuntime.make(
    HostStableRuntimeLayer.pipe(Layer.provide(primitiveLayer)),
  );

  runtimes.push(runtime);
  return runtime;
};

const memoryStorage = (): HostStorageOperations => {
  const values = new Map<string, string>();

  return {
    get: (key) => Effect.sync(() => Option.fromNullable(values.get(key))),
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
