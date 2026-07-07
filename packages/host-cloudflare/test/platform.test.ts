import { HostStorageError } from "@ptools/config";
import { Effect, Either, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeDurableObjectHostStorage } from "../src/layers/platform.js";
import { requestOrigin } from "../src/worker/request.js";

describe("makeDurableObjectHostStorage", () => {
  it("models missing and present string values with Option", async () => {
    const values = new Map<string, unknown>([["present", "value"]]);
    const storage = makeDurableObjectHostStorage(
      makeDurableObjectStorage({
        get: ((key: string) =>
          Promise.resolve(values.get(key))) as DurableObjectStorage["get"],
      }),
      "state",
    );

    const missing = await Effect.runPromise(storage.get("missing"));
    const present = await Effect.runPromise(storage.get("present"));

    expect(Option.isNone(missing)).toBe(true);
    expect(Option.getOrUndefined(present)).toBe("value");
  });

  it("maps Cloudflare failures into a typed host storage error", async () => {
    const cause = new Error("storage unavailable");
    const storage = makeDurableObjectHostStorage(
      makeDurableObjectStorage({
        get: (() => Promise.reject(cause)) as DurableObjectStorage["get"],
      }),
      "secret",
    );

    const result = await Effect.runPromise(
      storage.get("key").pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HostStorageError);
      expect(result.left).toMatchObject({
        storage: "secret",
        operation: "get",
        key: "key",
        cause,
      });
    }
  });
});

describe("requestOrigin", () => {
  it("uses the parsed URL origin, including an explicit port", () => {
    const request = new Request(
      "https://ptools.example:8787/hosts/demo/auth?next=https://other.example",
    );

    expect(requestOrigin(request)).toBe("https://ptools.example:8787");
  });
});

const makeDurableObjectStorage = (
  overrides: Partial<DurableObjectStorage>,
): DurableObjectStorage =>
  ({
    ...overrides,
  }) as DurableObjectStorage;
