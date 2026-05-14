import { describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import { NameCollisionError } from "../src/errors.js";
import {
  buildNameMap,
  getMappedName,
  sanitizeJsIdentifier,
} from "../src/names.js";

describe("names", () => {
  it("sanitizes MCP names into JavaScript identifiers", () => {
    expect(sanitizeJsIdentifier("github.create-issue")).toBe(
      "github_create_issue",
    );
    expect(sanitizeJsIdentifier("3d-render")).toBe("_d_render");
    expect(sanitizeJsIdentifier("delete")).toBe("delete_");
    expect(sanitizeJsIdentifier(" ")).toBe("_");
  });

  it("builds a reverse lookup map from original names to JS names", async () => {
    const map = await Effect.runPromise(
      buildNameMap(["create-issue", "list_issues"], "tools"),
    );

    expect(map.get("create-issue")).toBe("create_issue");
    expect(map.get("list_issues")).toBe("list_issues");
  });

  it("fails when two original names sanitize to the same JS name", async () => {
    const result = await Effect.runPromise(
      Effect.either(buildNameMap(["create-issue", "create_issue"], "tools")),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NameCollisionError);
      expect(result.left.jsName).toBe("create_issue");
      expect(result.left.originals).toEqual(["create-issue", "create_issue"]);
    }
  });

  it("fails if a mapped name is missing", async () => {
    const result = await Effect.runPromise(
      Effect.either(getMappedName(new Map(), "missing", "tools")),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NameCollisionError);
      expect(result.left.originals).toEqual(["missing"]);
    }
  });
});
