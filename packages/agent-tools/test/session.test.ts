import {
  CodeMode,
  type CodeModeDiagnostic,
  type CodeModeExecuteRequest,
  type CodeModeSearchRequest,
  type CodeModeToolSchemaRequest,
} from "@ptools/code-mode";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { makePtoolsSession } from "../src/session.js";
import type { CodeModeToolName } from "../src/types.js";

describe("PtoolsSession", () => {
  it("routes Code Mode tool calls to the matching service methods", async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const diagnostics = [diagnostic("McpDiscoveryFailed")];
    const session = makePtoolsSession(
      ManagedRuntime.make(
        Layer.succeed(CodeMode, {
          diagnostics: Effect.succeed(diagnostics),
          search: (request?: CodeModeSearchRequest) =>
            Effect.sync(() => {
              calls.push({ name: "search", input: request });
              return { servers: [], diagnostics };
            }),
          toolSchema: (request: CodeModeToolSchemaRequest) =>
            Effect.sync(() => {
              calls.push({ name: "get_tool_schema", input: request });
              return { tools: [], declarationsByServer: [], diagnostics };
            }),
          execute: (request: CodeModeExecuteRequest) =>
            Effect.sync(() => {
              calls.push({ name: "execute", input: request });
              return { value: request.code, logs: [] };
            }),
        }),
      ),
    );

    await expect(
      session.callCodeModeTool("search", { query: "issues" }),
    ).resolves.toEqual({ servers: [], diagnostics });
    await expect(
      session.callCodeModeTool("get_tool_schema", {
        tools: [{ jsServerName: "github", jsToolName: "create_issue" }],
      }),
    ).resolves.toEqual({ tools: [], declarationsByServer: [], diagnostics });
    await expect(
      session.callCodeModeTool("execute", {
        code: "async () => 1",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ value: "async () => 1", logs: [] });

    expect(calls).toEqual([
      { name: "search", input: { query: "issues" } },
      {
        name: "get_tool_schema",
        input: {
          tools: [{ jsServerName: "github", jsToolName: "create_issue" }],
        },
      },
      {
        name: "execute",
        input: { code: "async () => 1", timeoutMs: 1000 },
      },
    ]);
  });

  it("fails clearly for unknown Code Mode tool names", async () => {
    const session = makePtoolsSession(
      ManagedRuntime.make(
        Layer.succeed(CodeMode, {
          diagnostics: Effect.succeed([]),
          search: () => Effect.succeed({ servers: [], diagnostics: [] }),
          toolSchema: () =>
            Effect.succeed({
              tools: [],
              declarationsByServer: [],
              diagnostics: [],
            }),
          execute: () => Effect.succeed({ value: undefined, logs: [] }),
        }),
      ),
    );

    await expect(
      session.callCodeModeTool("missing" as CodeModeToolName, {}),
    ).rejects.toThrow("Unknown Code Mode tool: missing");
  });

  it("returns diagnostics and releases the managed runtime scope on close", async () => {
    let closed = false;
    const diagnostics = [diagnostic("McpConnectionFailed")];
    const runtime = ManagedRuntime.make(
      Layer.scoped(
        CodeMode,
        Effect.acquireRelease(
          Effect.succeed({
            diagnostics: Effect.succeed(diagnostics),
            search: () => Effect.succeed({ servers: [], diagnostics }),
            toolSchema: () =>
              Effect.succeed({
                tools: [],
                declarationsByServer: [],
                diagnostics,
              }),
            execute: () => Effect.succeed({ value: undefined, logs: [] }),
          }),
          () =>
            Effect.sync(() => {
              closed = true;
            }),
        ),
      ),
    );
    const session = makePtoolsSession(runtime);

    await expect(session.diagnostics()).resolves.toEqual(diagnostics);
    await session.close();

    expect(closed).toBe(true);
  });
});

describe("input parsing", () => {
  const session = () =>
    makePtoolsSession(
      ManagedRuntime.make(
        Layer.succeed(CodeMode, {
          diagnostics: Effect.succeed([]),
          search: () => Effect.succeed({ servers: [], diagnostics: [] }),
          toolSchema: () =>
            Effect.succeed({
              tools: [],
              declarationsByServer: [],
              diagnostics: [],
            }),
          execute: () => Effect.succeed({ value: undefined, logs: [] }),
        }),
      ),
    );

  describe("search input", () => {
    it("accepts undefined as an empty search", async () => {
      await expect(
        session().callCodeModeTool("search", undefined),
      ).resolves.toEqual({ servers: [], diagnostics: [] });
    });

    it("accepts an object with no query field", async () => {
      await expect(
        session().callCodeModeTool("search", {}),
      ).resolves.toEqual({ servers: [], diagnostics: [] });
    });

    it("rejects null input", async () => {
      await expect(
        session().callCodeModeTool("search", null),
      ).rejects.toThrow("search input must be an object");
    });

    it("rejects array input", async () => {
      await expect(
        session().callCodeModeTool("search", []),
      ).rejects.toThrow("search input must be an object");
    });

    it("rejects a non-string query", async () => {
      await expect(
        session().callCodeModeTool("search", { query: 42 }),
      ).rejects.toThrow("search.query must be a string when provided");
    });
  });

  describe("get_tool_schema input", () => {
    it("rejects null input", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", null),
      ).rejects.toThrow("get_tool_schema input must be an object");
    });

    it("rejects missing tools field", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", {}),
      ).rejects.toThrow("get_tool_schema.tools must be an array");
    });

    it("rejects non-array tools field", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", { tools: "echo" }),
      ).rejects.toThrow("get_tool_schema.tools must be an array");
    });

    it("rejects tool item that is not an object", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", { tools: [null] }),
      ).rejects.toThrow("get_tool_schema.tools[0] must be an object");
    });

    it("rejects tool item with missing jsServerName", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", {
          tools: [{ jsToolName: "echo" }],
        }),
      ).rejects.toThrow(
        "get_tool_schema.tools[0].jsServerName must be a string",
      );
    });

    it("rejects tool item with missing jsToolName", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", {
          tools: [{ jsServerName: "fixture" }],
        }),
      ).rejects.toThrow("get_tool_schema.tools[0].jsToolName must be a string");
    });
  });

  describe("execute input", () => {
    it("rejects null input", async () => {
      await expect(
        session().callCodeModeTool("execute", null),
      ).rejects.toThrow("execute input must be an object");
    });

    it("rejects missing code field", async () => {
      await expect(
        session().callCodeModeTool("execute", {}),
      ).rejects.toThrow("execute.code must be a string");
    });

    it("rejects non-string code field", async () => {
      await expect(
        session().callCodeModeTool("execute", { code: 42 }),
      ).rejects.toThrow("execute.code must be a string");
    });

    it("rejects non-number timeoutMs when provided", async () => {
      await expect(
        session().callCodeModeTool("execute", {
          code: "async () => 1",
          timeoutMs: "fast",
        }),
      ).rejects.toThrow("execute.timeoutMs must be a number when provided");
    });

    it("accepts code without timeoutMs", async () => {
      await expect(
        session().callCodeModeTool("execute", { code: "async () => 1" }),
      ).resolves.toEqual({ value: undefined, logs: [] });
    });
  });
});

const diagnostic = (
  code: "McpConnectionFailed" | "McpDiscoveryFailed",
): CodeModeDiagnostic => ({
  code,
  severity: "error",
  serverName: "fixture",
  message: "fixture diagnostic",
});
