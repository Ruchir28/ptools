import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostStateStorage } from "@ptools/config";
import { HostIdentityLayer } from "@ptools/host-context";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  NodeFileHostStateStorageBackendLayer,
  encodeHostId,
} from "../src/layers/platform/index.js";

describe("Node host storage adapters", () => {
  it("adapts file-backed KeyValueStore to exact-key HostStateStorage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ptools-host-state-"));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* HostStateStorage;
        const missing = yield* storage.get("missing");
        yield* storage.put("config/blob", "stored-config");
        const present = yield* storage.get("config/blob");
        yield* storage.delete("config/blob");
        yield* storage.delete("config/blob");
        const deleted = yield* storage.get("config/blob");

        return { missing, present, deleted };
      }).pipe(
        Effect.provide(
          HostStateStorage.Default.pipe(
            Layer.provide(NodeFileHostStateStorageBackendLayer(directory)),
            Layer.provide(HostIdentityLayer("demo")),
          ),
        ),
      ),
    );

    expect(Option.isNone(result.missing)).toBe(true);
    expect(Option.getOrUndefined(result.present)).toBe("stored-config");
    expect(Option.isNone(result.deleted)).toBe(true);
  });

  it("isolates identical logical keys by HostIdentity", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ptools-host-root-"));
    const layerFor = (hostId: string) =>
      HostStateStorage.Default.pipe(
        Layer.provide(NodeFileHostStateStorageBackendLayer(rootDirectory)),
        Layer.provide(HostIdentityLayer(hostId)),
      );
    const write = (hostId: string, value: string) =>
      Effect.gen(function* () {
        const storage = yield* HostStateStorage;
        yield* storage.put("config/blob", value);
      }).pipe(Effect.provide(layerFor(hostId)));
    const read = (hostId: string) =>
      Effect.gen(function* () {
        const storage = yield* HostStateStorage;
        return yield* storage.get("config/blob");
      }).pipe(Effect.provide(layerFor(hostId)));

    await Effect.runPromise(write("host-a", "config-a"));
    await Effect.runPromise(write("host-b", "config-b"));

    expect(Option.getOrUndefined(await Effect.runPromise(read("host-a")))).toBe(
      "config-a",
    );
    expect(Option.getOrUndefined(await Effect.runPromise(read("host-b")))).toBe(
      "config-b",
    );
  });

  it("encodes host ids safely for physical Node storage namespaces", () => {
    expect(encodeHostId("host/one two")).toBe("host%2Fone%20two");
    expect(encodeHostId("..")).toBe("%2E%2E");
  });
});
