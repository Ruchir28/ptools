import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostStateStorage } from "@ptools/config";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  NodeFileHostStateStorageLive,
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
      }).pipe(Effect.provide(NodeFileHostStateStorageLive(directory))),
    );

    expect(Option.isNone(result.missing)).toBe(true);
    expect(Option.getOrUndefined(result.present)).toBe("stored-config");
    expect(Option.isNone(result.deleted)).toBe(true);
  });

  it("encodes host ids for physical Node storage namespaces", () => {
    expect(encodeHostId("host/one two")).toBe("host%2Fone%20two");
  });
});
