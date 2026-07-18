import { join, normalize, resolve } from "node:path";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_HOST_KEYRING_SERVICE_NAME,
  NodeHostActorStateNamespaceError,
  nodeHostStateRootDirectory,
  resolveNodeHostActorRuntimeOptions,
} from "../src/hostActorDaemon/nodeHostActorStateNamespace.js";

const fixtureHome = resolve("fixture-home");
const fixtureState = resolve("fixture-state");
const fixturePtoolsHome = resolve("fixture-ptools-home");

describe("Node host-actor state namespace", () => {
  it("uses explicit daemon settings without authored config discovery", async () => {
    const options = await Effect.runPromise(
      resolveNodeHostActorRuntimeOptions(
        {
          internalStateDirectory: fixtureState,
          keyringServiceName: "test-host-secrets",
          denoExecutable: "fixture-deno",
        },
        { PTOOLS_HOME: resolve("ignored") },
        fixtureHome,
      ),
    );

    expect(options).toEqual({
      internalStateDirectory: normalize(fixtureState),
      keyringServiceName: "test-host-secrets",
      denoExecutable: "fixture-deno",
    });
    expect(nodeHostStateRootDirectory(options)).toBe(
      join(normalize(fixtureState), "hosts"),
    );
  });

  it("uses non-empty PTOOLS_HOME and the default keyring namespace", async () => {
    const options = await Effect.runPromise(
      resolveNodeHostActorRuntimeOptions(
        {},
        { PTOOLS_HOME: fixturePtoolsHome },
        fixtureHome,
      ),
    );

    expect(options).toEqual({
      internalStateDirectory: join(fixturePtoolsHome, "state"),
      keyringServiceName: DEFAULT_NODE_HOST_KEYRING_SERVICE_NAME,
    });
  });

  it("falls back to the OS home when PTOOLS_HOME is empty", async () => {
    const options = await Effect.runPromise(
      resolveNodeHostActorRuntimeOptions(
        {},
        { PTOOLS_HOME: "  " },
        fixtureHome,
      ),
    );

    expect(options.internalStateDirectory).toBe(
      join(fixtureHome, ".ptools", "state"),
    );
  });

  it.each([
    [
      { internalStateDirectory: "relative/state" },
      "internalStateDirectory must be an absolute path.",
    ],
    [
      { internalStateDirectory: "" },
      "internalStateDirectory must not be empty.",
    ],
    [{ keyringServiceName: "" }, "keyringServiceName must not be empty."],
    [
      { denoExecutable: "   " },
      "denoExecutable must not be empty when provided.",
    ],
  ] as const)(
    "rejects invalid override %j",
    async (overrides, expectedMessage) => {
      const result = await Effect.runPromise(
        resolveNodeHostActorRuntimeOptions(overrides, {}, fixtureHome).pipe(
          Effect.either,
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(NodeHostActorStateNamespaceError);
        expect(result.left.message).toBe(expectedMessage);
      }
    },
  );

  it("rejects relative PTOOLS_HOME rather than resolving against cwd", async () => {
    const result = await Effect.runPromise(
      resolveNodeHostActorRuntimeOptions(
        {},
        { PTOOLS_HOME: "relative/home" },
        fixtureHome,
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe("PTOOLS_HOME must be an absolute path.");
    }
  });
});
