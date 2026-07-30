import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
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
      Effect.result(buildNameMap(["create-issue", "create_issue"], "tools")),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(NameCollisionError);
      expect(result.failure.jsName).toBe("create_issue");
      expect(result.failure.originals).toEqual([
        "create-issue",
        "create_issue",
      ]);
    }
  });

  it("fails if a mapped name is missing", async () => {
    const result = await Effect.runPromise(
      Effect.result(getMappedName(new Map(), "missing", "tools")),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(NameCollisionError);
      expect(result.failure.originals).toEqual(["missing"]);
    }
  });
});
