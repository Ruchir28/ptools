import { Effect, Either, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CodeModeObjectStorageError,
  makeCodeModeObjectStorage,
} from "../src/layers/platform.js";
import { requestOrigin } from "../src/worker/request.js";

describe("makeCodeModeObjectStorage", () => {
  it("models missing and present values with Option", async () => {
    const values = new Map<string, unknown>([["present", "value"]]);
    const storage = makeCodeModeObjectStorage(
      makeDurableObjectStorage({
        get: ((key: string) =>
          Promise.resolve(values.get(key))) as DurableObjectStorage["get"],
      }),
    );

    const missing = await Effect.runPromise(storage.get<string>("missing"));
    const present = await Effect.runPromise(storage.get<string>("present"));

    expect(Option.isNone(missing)).toBe(true);
    expect(Option.getOrUndefined(present)).toBe("value");
  });

  it("maps Cloudflare failures into a typed storage error", async () => {
    const cause = new Error("storage unavailable");
    const storage = makeCodeModeObjectStorage(
      makeDurableObjectStorage({
        get: (() => Promise.reject(cause)) as DurableObjectStorage["get"],
      }),
    );

    const result = await Effect.runPromise(
      storage.get("key").pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(CodeModeObjectStorageError);
      expect(result.left).toMatchObject({
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
