import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodeMode,
  type CodeModeDiagnostic,
  type CodeModeExecuteRequest,
  type CodeModeSearchProvidersRequest,
  type CodeModeSearchRequest,
  type CodeModeToolSchemaRequest,
} from "@p_tools/code-mode";
import { ServerConfigError } from "@p_tools/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import {
  createPtoolsSessionFromConfigFile,
  loadPtoolsSessionConfig,
  makePtoolsSession,
} from "../src/session.js";
import type { CodeModeToolName } from "../src/types.js";

describe("PtoolsSession", () => {
  it("routes Code Mode tool calls to the matching service methods", async () => {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const diagnostics = [diagnostic("McpDiscoveryFailed")];
    const session = makePtoolsSession(
      ManagedRuntime.make(
        Layer.succeed(CodeMode, {
          diagnostics: Effect.succeed(diagnostics),
          authStatus: Effect.succeed({
            authUrl: "http://127.0.0.1:9999/auth",
            servers: [],
          }),
          refresh: Effect.void,
          searchProviders: (request?: CodeModeSearchProvidersRequest) =>
            Effect.sync(() => {
              calls.push({ name: "search_providers", input: request });
              return { providers: [], diagnostics };
            }),
          search: (request: CodeModeSearchRequest) =>
            Effect.sync(() => {
              calls.push({ name: "search", input: request });
              return { actions: [], diagnostics };
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
      session.callCodeModeTool("search_providers", {}),
    ).resolves.toEqual({ providers: [], diagnostics });
    await expect(
      session.callCodeModeTool("search", { query: "issues" }),
    ).resolves.toEqual({ actions: [], diagnostics });
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
      { name: "search_providers", input: {} },
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
          authStatus: Effect.succeed({
            authUrl: "http://127.0.0.1:9999/auth",
            servers: [],
          }),
          refresh: Effect.void,
          searchProviders: () =>
            Effect.succeed({ providers: [], diagnostics: [] }),
          search: () => Effect.succeed({ actions: [], diagnostics: [] }),
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
            authStatus: Effect.succeed({
              authUrl: "http://127.0.0.1:9999/auth",
              servers: [],
            }),
            refresh: Effect.void,
            searchProviders: () =>
              Effect.succeed({ providers: [], diagnostics }),
            search: () => Effect.succeed({ actions: [], diagnostics }),
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

describe("config-file session loading", () => {
  it("loads a valid config file into session options", async () => {
    const configPath = await writeConfig("valid", {
      mcpServers: {
        fixture: {
          command: "node",
          args: ["server.js"],
        },
      },
      executor: {
        defaultTimeoutMs: 1234,
      },
    });

    await expect(loadPtoolsSessionConfig(configPath)).resolves.toEqual({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      executor: {
        defaultTimeoutMs: 1234,
      },
    });
  });

  it("defaults to ptools.config.json in the provided cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-agent-tools-default-"));
    const configPath = join(dir, "ptools.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: "node",
          },
        },
      }),
    );

    await expect(
      loadPtoolsSessionConfig(undefined, { cwd: dir }),
    ).resolves.toMatchObject({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: "node",
        },
      },
    });
  });

  it("resolves explicit relative config paths from the provided cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-agent-tools-relative-"));
    const configPath = join(dir, "nested.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://example.com/mcp",
          },
        },
      }),
    );

    await expect(
      loadPtoolsSessionConfig("nested.config.json", { cwd: dir }),
    ).resolves.toMatchObject({
      mcpServers: {
        docs: {
          transport: "http",
          url: "https://example.com/mcp",
        },
      },
    });
  });

  it("resolves stdio cwd values from the config file directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-agent-tools-cwd-"));
    const configPath = join(dir, "nested.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: "node",
            cwd: "fixtures",
          },
        },
      }),
    );

    await expect(loadPtoolsSessionConfig(configPath)).resolves.toMatchObject({
      mcpServers: {
        fixture: {
          cwd: join(dir, "fixtures"),
        },
      },
    });
  });

  it("resolves env placeholders from the provided env map", async () => {
    const configPath = await writeConfig("env", {
      mcpServers: {
        fixture: {
          command: "${env:NODE_BIN}",
          env: {
            TOKEN: "${env:FIXTURE_TOKEN}",
          },
        },
        remote: {
          url: "https://example.com/mcp",
          headers: {
            authorization: "Bearer ${env:REMOTE_TOKEN}",
          },
        },
      },
    });

    await expect(
      loadPtoolsSessionConfig(configPath, {
        env: {
          NODE_BIN: "node",
          FIXTURE_TOKEN: "secret",
          REMOTE_TOKEN: "remote-secret",
        },
      }),
    ).resolves.toMatchObject({
      mcpServers: {
        fixture: {
          command: "node",
          env: {
            TOKEN: "secret",
          },
        },
        remote: {
          headers: {
            authorization: "Bearer remote-secret",
          },
        },
      },
    });
  });

  it("rejects missing env placeholders with ServerConfigError", async () => {
    const configPath = await writeConfig("missing-env", {
      mcpServers: {
        fixture: {
          command: "${env:MISSING_NODE_BIN}",
        },
      },
    });

    await expect(
      loadPtoolsSessionConfig(configPath, { env: {} }),
    ).rejects.toThrow(ServerConfigError);
    await expect(
      loadPtoolsSessionConfig(configPath, { env: {} }),
    ).rejects.toThrow("MISSING_NODE_BIN");
  });

  it("rejects invalid JSON and invalid config shape clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-agent-tools-invalid-"));
    const invalidJsonPath = join(dir, "invalid-json.config.json");
    const invalidShapePath = join(dir, "invalid-shape.config.json");

    await writeFile(invalidJsonPath, "{");
    await writeFile(
      invalidShapePath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: 42,
          },
        },
      }),
    );

    await expect(loadPtoolsSessionConfig(invalidJsonPath)).rejects.toThrow(
      "Invalid JSON",
    );
    await expect(loadPtoolsSessionConfig(invalidShapePath)).rejects.toThrow(
      "command must be a string",
    );
  });

  it("rejects ambiguous and old transport/type configs clearly", async () => {
    const ambiguous = await writeConfig("ambiguous", {
      mcpServers: {
        fixture: {
          command: "node",
          url: "https://example.com/mcp",
        },
      },
    });
    const withTransport = await writeConfig("transport", {
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: "node",
        },
      },
    });
    const withType = await writeConfig("type", {
      mcpServers: {
        fixture: {
          type: "stdio",
          command: "node",
        },
      },
    });

    await expect(loadPtoolsSessionConfig(ambiguous)).rejects.toThrow(
      "not both",
    );
    await expect(loadPtoolsSessionConfig(withTransport)).rejects.toThrow(
      "use command",
    );
    await expect(loadPtoolsSessionConfig(withType)).rejects.toThrow(
      "use command",
    );
  });

  it("excludes disabled servers", async () => {
    const configPath = await writeConfig("disabled", {
      mcpServers: {
        fixture: {
          command: "node",
          disabled: false,
        },
        off: {
          command: "node",
          disabled: true,
        },
        alsoOff: {
          url: "https://example.com/mcp",
          enabled: false,
        },
      },
    });

    await expect(loadPtoolsSessionConfig(configPath)).resolves.toMatchObject({
      mcpServers: {
        fixture: {
          transport: "stdio",
        },
      },
    });

    const loaded = await loadPtoolsSessionConfig(configPath);

    expect(Object.keys(loaded.mcpServers)).toEqual(["fixture"]);
  });

  it("runs a real Code Mode vertical slice from a config file", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
        import.meta.url,
      ),
    );
    const configPath = await writeConfig("vertical", {
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ["--import", "tsx", fixturePath],
        },
      },
    });
    const ptools = await createPtoolsSessionFromConfigFile(configPath);

    try {
      const providers = await ptools.callCodeModeTool("search_providers", {});
      const search = await ptools.callCodeModeTool("search", { query: "echo" });
      const schema = await ptools.callCodeModeTool("get_tool_schema", {
        toolIds: ["fixture.echo"],
      });
      const execution = await ptools.callCodeModeTool("execute", {
        code: `async () => {
          return await fixture.echo({ text: "hello from config file" });
        }`,
      });

      expect(toProviderNames(providers)).toEqual(["fixture"]);
      expect(toToolKeys(search)).toEqual(["fixture.echo"]);
      expect(toSchemaToolKeys(schema)).toEqual(["fixture.echo"]);
      expect(execution).toEqual({
        value: { text: "hello from config file" },
        logs: [],
      });
    } finally {
      await ptools.close();
    }
  }, 30_000);
});

describe("input parsing", () => {
  const session = () =>
    makePtoolsSession(
      ManagedRuntime.make(
        Layer.succeed(CodeMode, {
          diagnostics: Effect.succeed([]),
          authStatus: Effect.succeed({
            authUrl: "http://127.0.0.1:9999/auth",
            servers: [],
          }),
          refresh: Effect.void,
          searchProviders: () =>
            Effect.succeed({ providers: [], diagnostics: [] }),
          search: () => Effect.succeed({ actions: [], diagnostics: [] }),
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
      ).rejects.toThrow("get_tool_schema requires toolIds or tools");
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

const writeConfig = async (name: string, value: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `ptools-agent-tools-${name}-`));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(configPath, JSON.stringify(value, null, 2));

  return configPath;
};

const toToolKeys = (value: unknown): ReadonlyArray<string> => {
  const context = value as {
    readonly actions: ReadonlyArray<{ readonly toolId: string }>;
  };

  return context.actions.map((action) => action.toolId);
};

const toProviderNames = (value: unknown): ReadonlyArray<string> => {
  const context = value as {
    readonly providers: ReadonlyArray<{ readonly provider: string }>;
  };

  return context.providers.map((provider) => provider.provider);
};

const toSchemaToolKeys = (value: unknown): ReadonlyArray<string> => {
  const context = value as {
    readonly tools: ReadonlyArray<{
      readonly jsServerName: string;
      readonly jsToolName: string;
    }>;
  };

  return context.tools.map((tool) => `${tool.jsServerName}.${tool.jsToolName}`);
};
