import type {
  CodeModeClientHandle,
  CodeModeDiagnostic,
  CodeModeRequest,
  CodeModeResponse,
  CodeModeToolName,
} from "@ptools/code-mode-api";
import { describe, expect, it } from "vitest";
import { makePtoolsSession } from "../src/session.js";

describe("PtoolsSession", () => {
  it("routes all Code Mode operations through the provided client", async () => {
    const calls: CodeModeRequest[] = [];
    const diagnostics = [diagnostic("McpDiscoveryFailed")];
    const session = makePtoolsSession(
      fakeClient((request) => {
        calls.push(request);

        switch (request.operation) {
          case "auth_status":
            return {
              operation: "auth_status",
              output: {
                authUrl: "http://127.0.0.1:9999/auth",
                servers: [],
              },
            };
          case "refresh":
            return { operation: "refresh", output: { refreshed: true } };
          case "search_providers":
            return {
              operation: "search_providers",
              output: { providers: [], diagnostics },
            };
          case "search":
            return {
              operation: "search",
              output: { actions: [], diagnostics },
            };
          case "get_tool_schema":
            return {
              operation: "get_tool_schema",
              output: { tools: [], declarationsByServer: [], diagnostics },
            };
          case "execute":
            return {
              operation: "execute",
              output: { value: request.input.code, logs: [] },
            };
        }
      }),
    );

    await expect(
      session.callCodeModeTool("auth_status", undefined),
    ).resolves.toEqual({
      authUrl: "http://127.0.0.1:9999/auth",
      servers: [],
    });
    await expect(
      session.callCodeModeTool("refresh", undefined),
    ).resolves.toEqual({ refreshed: true });
    await expect(
      session.callCodeModeTool("search_providers", {}),
    ).resolves.toEqual({ providers: [], diagnostics });
    await expect(
      session.callCodeModeTool("search", { query: "issues" }),
    ).resolves.toEqual({ actions: [], diagnostics });
    await expect(
      session.callCodeModeTool("get_tool_schema", {
        toolIds: ["github.create_issue"],
      }),
    ).resolves.toEqual({ tools: [], declarationsByServer: [], diagnostics });
    await expect(
      session.callCodeModeTool("execute", {
        code: "async () => 1",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ value: "async () => 1", logs: [] });

    expect(calls).toEqual([
      { operation: "auth_status" },
      { operation: "refresh" },
      { operation: "search_providers", input: {} },
      { operation: "search", input: { query: "issues" } },
      {
        operation: "get_tool_schema",
        input: { toolIds: ["github.create_issue"] },
      },
      {
        operation: "execute",
        input: { code: "async () => 1", timeoutMs: 1000 },
      },
    ]);
  });

  it("fails clearly for unknown Code Mode tool names", async () => {
    const session = makePtoolsSession(
      fakeClient(() => {
        throw new Error("should not be called");
      }),
    );

    await expect(
      session.callCodeModeTool("missing" as CodeModeToolName, {}),
    ).rejects.toThrow("Unknown Code Mode operation: missing");
  });

  it("returns diagnostics through provider discovery and closes the client", async () => {
    let closed = false;
    const diagnostics = [diagnostic("McpConnectionFailed")];
    const session = makePtoolsSession({
      call: async () => ({
        operation: "search_providers",
        output: { providers: [], diagnostics },
      }),
      close: async () => {
        closed = true;
      },
    });

    await expect(session.diagnostics()).resolves.toEqual(diagnostics);
    await session.close();

    expect(closed).toBe(true);
  });

  it("fails when the client returns a mismatched operation envelope", async () => {
    const session = makePtoolsSession({
      call: async () => ({
        operation: "refresh",
        output: { refreshed: true },
      }),
      close: async () => {},
    });

    await expect(
      session.callCodeModeTool("search", { query: "echo" }),
    ).rejects.toThrow("Code Mode client returned refresh for search");
  });
});

describe("input parsing", () => {
  const session = () =>
    makePtoolsSession(
      fakeClient((request) => {
        switch (request.operation) {
          case "auth_status":
            return {
              operation: "auth_status",
              output: { authUrl: "http://127.0.0.1:9999/auth", servers: [] },
            };
          case "refresh":
            return { operation: "refresh", output: { refreshed: true } };
          case "search_providers":
            return {
              operation: "search_providers",
              output: { providers: [], diagnostics: [] },
            };
          case "search":
            return {
              operation: "search",
              output: { actions: [], diagnostics: [] },
            };
          case "get_tool_schema":
            return {
              operation: "get_tool_schema",
              output: { tools: [], declarationsByServer: [], diagnostics: [] },
            };
          case "execute":
            return {
              operation: "execute",
              output: { value: undefined, logs: [] },
            };
        }
      }),
    );

  describe("auth_status and refresh input", () => {
    it("accepts absent input", async () => {
      await expect(
        session().callCodeModeTool("auth_status", undefined),
      ).resolves.toEqual({
        authUrl: "http://127.0.0.1:9999/auth",
        servers: [],
      });
      await expect(
        session().callCodeModeTool("refresh", undefined),
      ).resolves.toEqual({ refreshed: true });
    });

    it("rejects provided input", async () => {
      await expect(session().callCodeModeTool("refresh", {})).rejects.toThrow(
        "refresh input must be absent",
      );
    });
  });

  describe("search_providers input", () => {
    it("accepts undefined as provider inventory search", async () => {
      await expect(
        session().callCodeModeTool("search_providers", undefined),
      ).resolves.toEqual({ providers: [], diagnostics: [] });
    });

    it("accepts an object with no query field for provider inventory", async () => {
      await expect(
        session().callCodeModeTool("search_providers", {}),
      ).resolves.toEqual({
        providers: [],
        diagnostics: [],
      });
    });

    it("rejects non-string provider query", async () => {
      await expect(
        session().callCodeModeTool("search_providers", { query: 42 }),
      ).rejects.toThrow(
        "search_providers.query must be a string when provided",
      );
    });
  });

  describe("search input", () => {
    it("rejects null input", async () => {
      await expect(session().callCodeModeTool("search", null)).rejects.toThrow(
        "search input must be an object",
      );
    });

    it("rejects array input", async () => {
      await expect(session().callCodeModeTool("search", [])).rejects.toThrow(
        "search input must be an object",
      );
    });

    it("rejects a non-string query", async () => {
      await expect(
        session().callCodeModeTool("search", { query: 42 }),
      ).rejects.toThrow("search.query must be a non-blank string");
    });

    it("rejects a missing query", async () => {
      await expect(session().callCodeModeTool("search", {})).rejects.toThrow(
        "search.query must be a non-blank string",
      );
    });

    it("accepts a task query", async () => {
      await expect(
        session().callCodeModeTool("search", { query: "echo" }),
      ).resolves.toEqual({ actions: [], diagnostics: [] });
    });
  });

  describe("get_tool_schema input", () => {
    it("rejects null input", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", null),
      ).rejects.toThrow("get_tool_schema input must be an object");
    });

    it("rejects missing selector fields", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", {}),
      ).rejects.toThrow("get_tool_schema.toolIds must be an array");
    });

    it("accepts toolIds", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", {
          toolIds: ["fixture.echo"],
        }),
      ).resolves.toEqual({
        tools: [],
        declarationsByServer: [],
        diagnostics: [],
      });
    });

    it("rejects empty toolIds", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", { toolIds: [] }),
      ).rejects.toThrow("get_tool_schema requires at least one toolId");
    });

    it("rejects non-array toolIds field", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", { toolIds: "echo" }),
      ).rejects.toThrow("get_tool_schema.toolIds must be an array");
    });

    it("rejects a blank toolId", async () => {
      await expect(
        session().callCodeModeTool("get_tool_schema", {
          toolIds: [""],
        }),
      ).rejects.toThrow(
        "get_tool_schema.toolIds[0] must be a non-blank string",
      );
    });
  });

  describe("execute input", () => {
    it("rejects null input", async () => {
      await expect(session().callCodeModeTool("execute", null)).rejects.toThrow(
        "execute input must be an object",
      );
    });

    it("rejects missing code field", async () => {
      await expect(session().callCodeModeTool("execute", {})).rejects.toThrow(
        "execute.code must be a string",
      );
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

const fakeClient = (
  handle: (request: CodeModeRequest) => CodeModeResponse,
): CodeModeClientHandle => ({
  call: async (request) => handle(request),
  close: async () => {},
});
