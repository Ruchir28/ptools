import { Effect, Either, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CodeModeClient,
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeServer,
  CodeModeToolSchemaRequest,
  parseCodeModeRequest,
  parseCodeModeToolCall,
  type CodeModeRequest,
  type CodeModeResponse,
} from "../src/index.js";

describe("Code Mode API request validation", () => {
  it("parses all public operations", async () => {
    await expect(parseToolCall("auth_status", undefined)).resolves.toEqual({
      operation: "auth_status",
    });
    await expect(parseToolCall("refresh", undefined)).resolves.toEqual({
      operation: "refresh",
    });
    await expect(
      parseToolCall("search_providers", { query: "github", limit: 1 }),
    ).resolves.toEqual({
      operation: "search_providers",
      input: CodeModeSearchProvidersRequest.make({
        query: Option.some("github"),
        limit: Option.some(1),
      }),
    });
    await expect(
      parseToolCall("search", {
        query: "create issue",
        provider: "github",
        limit: 2,
      }),
    ).resolves.toEqual({
      operation: "search",
      input: CodeModeSearchRequest.make({
        query: "create issue",
        provider: Option.some("github"),
        limit: Option.some(2),
      }),
    });
    await expect(
      parseToolCall("get_tool_schema", { toolIds: ["github.create_issue"] }),
    ).resolves.toEqual({
      operation: "get_tool_schema",
      input: CodeModeToolSchemaRequest.make({
        toolIds: ["github.create_issue"],
      }),
    });
    await expect(
      parseToolCall("execute", { code: "async () => 1", timeoutMs: 1000 }),
    ).resolves.toEqual({
      operation: "execute",
      input: CodeModeExecuteRequest.make({
        code: "async () => 1",
        timeoutMs: Option.some(1000),
      }),
    });
  });

  it("parses request envelopes", async () => {
    await expect(
      Effect.runPromise(
        parseCodeModeRequest({
          operation: "search",
          input: { query: "issues" },
        }),
      ),
    ).resolves.toEqual({
      operation: "search",
      input: CodeModeSearchRequest.make({
        query: "issues",
        provider: Option.none(),
        limit: Option.none(),
      }),
    });
  });

  it.each([
    ["auth_status", {}],
    ["refresh", {}],
    ["search_providers", { limit: 0 }],
    ["search", { query: " " }],
    ["get_tool_schema", {}],
    ["get_tool_schema", { toolIds: [] }],
    ["get_tool_schema", { toolIds: [""] }],
    ["execute", {}],
    ["execute", { code: "async () => 1", timeoutMs: "fast" }],
  ])("rejects invalid %s input", async (operation, input) => {
    const result = await Effect.runPromise(
      Effect.either(parseCodeModeToolCall(operation, input)),
    );

    expect(Either.isLeft(result)).toBe(true);
  });

  it("fails with a typed error for unknown operations", async () => {
    const result = await Effect.runPromise(
      Effect.either(parseCodeModeToolCall("missing", {})),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("CodeModeInvalidRequestError");
      expect(result.left.message).toBe("Unknown Code Mode operation: missing");
    }
  });

  it("fails with a typed error for invalid request envelopes", async () => {
    const result = await Effect.runPromise(
      Effect.either(parseCodeModeRequest(null)),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("CodeModeInvalidRequestError");
      expect(result.left.message).toBe("Code Mode request must be an object");
    }
  });
});

describe("Code Mode API services", () => {
  it("provides CodeModeClient with Layer.succeed", async () => {
    const request: CodeModeRequest = {
      operation: "search",
      input: CodeModeSearchRequest.make({
        query: "github",
        provider: Option.none(),
        limit: Option.none(),
      }),
    };
    const response: CodeModeResponse = {
      operation: "search",
      output: { actions: [], diagnostics: [] },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* CodeModeClient;
          return yield* client.call(request);
        }).pipe(
          Effect.provide(
            Layer.succeed(CodeModeClient, {
              call: () => Effect.succeed(response),
            }),
          ),
        ),
      ),
    ).resolves.toEqual(response);
  });

  it("provides CodeModeServer with Layer.succeed", async () => {
    const request: CodeModeRequest = {
      operation: "search_providers",
    };
    const response: CodeModeResponse = {
      operation: "search_providers",
      output: { providers: [], diagnostics: [] },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodeModeServer;
          return yield* server.handle(request);
        }).pipe(
          Effect.provide(
            Layer.succeed(CodeModeServer, {
              handle: () => Effect.succeed(response),
            }),
          ),
        ),
      ),
    ).resolves.toEqual(response);
  });
});

const parseToolCall = (
  operation: string,
  input: unknown,
): Promise<CodeModeRequest> =>
  Effect.runPromise(parseCodeModeToolCall(operation, input));
