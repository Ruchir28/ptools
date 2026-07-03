import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
} from "@ptools/code-mode-api";
import { CodeModeClient, CodeModeServer } from "@ptools/code-mode-api/effect";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  createNodeCodeModeClient,
  createNodeHostClient,
  NodeCodeModeClientLive,
  NodeCodeModeServerLive,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
    import.meta.url,
  ),
);

const hasDeno = (() => {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Node Code Mode executor startup", () => {
  it("surfaces actionable Deno resolution failures", async () => {
    await expect(
      createNodeCodeModeClient(await writeConfig("missing-deno", {
        mcpServers: {},
      }), {
        executor: {
          denoExecutable: "/definitely/missing/ptools-deno",
        },
      }),
    ).rejects.toThrow(
      'Failed to start local Node Code Mode. Deno 2 or newer was not found using the configured denoExecutable ("/definitely/missing/ptools-deno"). Install Deno, set DENO_BIN, or pass denoExecutable.',
    );
  });
});

describe.skipIf(!hasDeno)("Node Code Mode host assembly", () => {
  it("creates a client from an explicit config file through ConfigSource", async () => {
    const configPath = await writeFixtureConfig("config-file");
    const client = await createNodeCodeModeClient(configPath);

    try {
      await expect(
        client.call({ operation: "search", input: searchRequest("echo") }),
      ).resolves.toMatchObject({
        operation: "search",
        output: {
          actions: [{ toolId: "fixture.echo" }],
        },
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("exposes MCP auth status through the Node Host API for file-backed config", async () => {
    const configPath = await writeConfig("mcp-auth-status", {
      mcpServers: {
        remote: {
          url: "https://example.invalid/mcp",
          auth: { type: "oauth" },
        },
      },
    });
    const host = await createNodeHostClient(configPath, { env: {} });

    try {
      const response = await host.call({ operation: "mcp_auth_status", input: { origin: "http://127.0.0.1" } });

      expect(response).toMatchObject({
        operation: "mcp_auth_status",
        result: {
          ok: true,
          status: {
            servers: [
              {
                serverName: "remote",
                transport: "http",
              },
            ],
          },
        },
      });
    } finally {
      await host.close();
    }
  }, 30_000);

  it("provides CodeModeServer and CodeModeClient layers from config file sources", async () => {
    const configPath = await writeFixtureConfig("layers");

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodeModeServer;

          return yield* server.handle({
            operation: "search_providers",
            input: searchProvidersRequest(),
          });
        }).pipe(
          Effect.provide(
            NodeCodeModeServerLive(configPath, {
              env: {},
            }),
          ),
          Effect.scoped,
        ),
      ),
    ).resolves.toMatchObject({
      operation: "search_providers",
      output: { providers: [{ provider: "fixture" }] },
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* CodeModeClient;

          return yield* client.call({
            operation: "search",
            input: searchRequest("echo"),
          });
        }).pipe(
          Effect.provide(
            NodeCodeModeClientLive(configPath, {
              env: {},
            }),
          ),
          Effect.scoped,
        ),
      ),
    ).resolves.toMatchObject({
      operation: "search",
      output: { actions: [{ toolId: "fixture.echo" }] },
    });
  }, 30_000);

});

const searchProvidersRequest = (): CodeModeSearchProvidersRequest =>
  CodeModeSearchProvidersRequest.make({
    query: Option.none(),
    limit: Option.none(),
  });

const searchRequest = (query: string): CodeModeSearchRequest =>
  CodeModeSearchRequest.make({
    query,
    provider: Option.none(),
    limit: Option.none(),
  });

const executeRequest = (code: string): CodeModeExecuteRequest =>
  CodeModeExecuteRequest.make({
    code,
    timeoutMs: Option.none(),
  });

const writeFixtureConfig = async (name: string): Promise<string> =>
  writeConfig(name, {
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: ["--import", "tsx", fixturePath],
      },
    },
  });

const writeConfig = async (
  name: string,
  config: unknown,
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `ptools-host-node-${name}-`));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(configPath, JSON.stringify(config, null, 2));

  return configPath;
};
