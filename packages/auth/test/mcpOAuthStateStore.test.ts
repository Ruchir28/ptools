import { HostSecretStorage, type HostStorageOperations } from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { McpOAuthStateStore, type McpOAuthStatePayload } from "../src/index.js";

/**
 * Security contract for the state value carried through an external browser.
 * These tests exercise the store directly: route and platform tests should not
 * be the only protection against accepting a callback for the wrong host,
 * provider, or authorization attempt.
 */
describe("McpOAuthStateStore.layer", () => {
  it("rejects a state for another host without consuming the issuing host's state", async () => {
    const fixture = makeStateStoreFixture();
    const state = await sign(fixture.layer, payload());

    await expect(
      verify(fixture.layer, state, { hostId: "other", provider: "fixture" }),
    ).rejects.toThrow("Invalid OAuth state.");

    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "fixture" }),
    ).resolves.toMatchObject({ hostId: "demo", provider: "fixture" });
  });

  it("rejects a state for another provider without consuming it", async () => {
    const fixture = makeStateStoreFixture();
    const state = await sign(fixture.layer, payload());

    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "other" }),
    ).rejects.toThrow("Invalid OAuth state.");

    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "fixture" }),
    ).resolves.toMatchObject({ hostId: "demo", provider: "fixture" });
  });

  it("rejects a tampered state without consuming the issued state", async () => {
    const fixture = makeStateStoreFixture();
    const state = await sign(fixture.layer, payload());
    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;

    await expect(
      verify(fixture.layer, tampered, { hostId: "demo", provider: "fixture" }),
    ).rejects.toThrow("Invalid OAuth state.");

    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "fixture" }),
    ).resolves.toMatchObject({ hostId: "demo", provider: "fixture" });
  });

  it("rejects an expired state", async () => {
    const fixture = makeStateStoreFixture();
    const state = await sign(
      fixture.layer,
      payload({
        issuedAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:10:00.000Z",
      }),
    );

    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "fixture" }),
    ).rejects.toThrow("Invalid OAuth state.");
  });

  it("consumes a valid state exactly once", async () => {
    const fixture = makeStateStoreFixture();
    const state = await sign(fixture.layer, payload());

    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "fixture" }),
    ).resolves.toMatchObject({ hostId: "demo", provider: "fixture" });
    await expect(
      verify(fixture.layer, state, { hostId: "demo", provider: "fixture" }),
    ).rejects.toThrow("Invalid OAuth state.");
  });
});

const payload = (
  overrides: Partial<McpOAuthStatePayload> = {},
): McpOAuthStatePayload => {
  const issuedAt = new Date();
  return {
    provider: "fixture",
    hostId: "demo",
    serverName: "fixture",
    nonce: "fixture-nonce",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
};

const sign = (
  layer: Layer.Layer<McpOAuthStateStore>,
  input: McpOAuthStatePayload,
) =>
  Effect.runPromise(
    Effect.flatMap(McpOAuthStateStore, (store) =>
      store.sign({ payload: input }),
    ).pipe(Effect.provide(layer)),
  );

const verify = (
  layer: Layer.Layer<McpOAuthStateStore>,
  rawState: string,
  expected: { readonly hostId: string; readonly provider: string },
) =>
  Effect.runPromise(
    Effect.flatMap(McpOAuthStateStore, (store) =>
      store.verifyAndConsume({
        rawState,
        expectedHostId: expected.hostId,
        expectedProvider: expected.provider,
      }),
    ).pipe(Effect.provide(layer)),
  );

const makeStateStoreFixture = () => {
  const values = new Map<string, string>();
  const storage: HostStorageOperations = {
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => void values.delete(key)),
  };
  const hostSecretStorage = HostSecretStorage.of({
    hostId: "demo",
    ...storage,
  });

  return {
    layer: McpOAuthStateStore.layer.pipe(
      Layer.provide(Layer.succeed(HostSecretStorage, hostSecretStorage)),
    ),
  };
};
