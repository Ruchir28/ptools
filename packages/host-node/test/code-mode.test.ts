import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeModeClient, CodeModeServer } from "@ptools/code-mode-api";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createNodeCodeModeClient,
  createNodeCodeModeClientFromConfigFile,
  NodeCodeModeClientFromConfigFileLive,
  NodeCodeModeClientLive,
  NodeCodeModeServerFromConfigFileLive,
  NodeCodeModeServerLive,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../mcp-registry/test/fixtures/stdio-mcp-server.ts",
    import.meta.url,
  ),
);

describe("Node Code Mode host assembly", () => {
  it("creates a client from in-memory resolved upstream config", async () => {
    const client = await createNodeCodeModeClient({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixturePath],
        },
      },
    });

    try {
      await expect(
        client.call({ operation: "search_providers", input: {} }),
      ).resolves.toMatchObject({
        operation: "search_providers",
        output: {
          providers: [{ provider: "fixture" }],
        },
      });
      await expect(
        client.call({
          operation: "execute",
          input: {
            code: `async () => {
              return await fixture.echo({ text: "hello from host-node" });
            }`,
          },
        }),
      ).resolves.toEqual({
        operation: "execute",
        output: {
          value: { text: "hello from host-node" },
          logs: [],
        },
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("creates a client from an explicit config file through ConfigSource", async () => {
    const configPath = await writeFixtureConfig("config-file");
    const client = await createNodeCodeModeClientFromConfigFile(configPath);

    try {
      await expect(
        client.call({ operation: "search", input: { query: "echo" } }),
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

  it("provides CodeModeServer and CodeModeClient layers from config file sources", async () => {
    const configPath = await writeFixtureConfig("layers");

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodeModeServer;

          return yield* server.handle({
            operation: "search_providers",
            input: {},
          });
        }).pipe(
          Effect.provide(
            NodeCodeModeServerFromConfigFileLive(configPath, {
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
            input: { query: "echo" },
          });
        }).pipe(
          Effect.provide(
            NodeCodeModeClientFromConfigFileLive(configPath, {
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

  it("provides direct CodeModeServer and CodeModeClient layers from options", async () => {
    const options = {
      mcpServers: {
        fixture: {
          transport: "stdio" as const,
          command: process.execPath,
          args: ["--import", "tsx", fixturePath],
        },
      },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* CodeModeServer;

          return yield* server.handle({
            operation: "search",
            input: { query: "echo" },
          });
        }).pipe(Effect.provide(NodeCodeModeServerLive(options)), Effect.scoped),
      ),
    ).resolves.toMatchObject({
      operation: "search",
      output: { actions: [{ toolId: "fixture.echo" }] },
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* CodeModeClient;

          return yield* client.call({
            operation: "search_providers",
            input: {},
          });
        }).pipe(Effect.provide(NodeCodeModeClientLive(options)), Effect.scoped),
      ),
    ).resolves.toMatchObject({
      operation: "search_providers",
      output: { providers: [{ provider: "fixture" }] },
    });
  }, 30_000);
});

const writeFixtureConfig = async (name: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `ptools-host-node-${name}-`));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: ["--import", "tsx", fixturePath],
          },
        },
      },
      null,
      2,
    ),
  );

  return configPath;
};
