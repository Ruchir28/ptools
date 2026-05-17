import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  parsePtoolsConfigJson,
  resolveConfigPath,
  resolvePtoolsConfig,
} from "../src/config.js";

describe("server config", () => {
  it("resolves valid stdio config to registry-compatible config", async () => {
    const config = await parseConfig({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          cwd: "/tmp",
        },
      },
    });

    const resolved = await Effect.runPromise(resolvePtoolsConfig(config, {}));

    expect(resolved).toEqual({
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          cwd: "/tmp",
        },
      },
    });
  });

  it("resolves valid HTTP config to registry-compatible config", async () => {
    const config = await parseConfig({
      mcpServers: {
        docs: {
          transport: "http",
          url: "https://example.com/mcp",
        },
      },
    });

    const resolved = await Effect.runPromise(resolvePtoolsConfig(config, {}));

    expect(resolved).toEqual({
      mcpServers: {
        docs: {
          transport: "http",
          url: "https://example.com/mcp",
        },
      },
    });
  });

  it("preserves literal env and headers", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          env: {
            LOG_LEVEL: "debug",
          },
        },
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: {
            "x-client": "ptools",
          },
        },
      },
    });

    const resolved = await Effect.runPromise(resolvePtoolsConfig(config, {}));

    expect(resolved.mcpServers.local).toMatchObject({
      env: { LOG_LEVEL: "debug" },
    });
    expect(resolved.mcpServers.remote).toMatchObject({
      headers: { "x-client": "ptools" },
    });
  });

  it("resolves envFrom and headersFromEnv", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          env: {
            LOG_LEVEL: "info",
          },
          envFrom: {
            TOKEN: "SOURCE_TOKEN",
          },
        },
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: {
            "x-client": "ptools",
          },
          headersFromEnv: {
            authorization: "REMOTE_AUTH",
          },
        },
      },
      executor: {
        defaultTimeoutMs: 1234,
      },
    });

    const resolved = await Effect.runPromise(
      resolvePtoolsConfig(config, {
        SOURCE_TOKEN: "secret-token",
        REMOTE_AUTH: "Bearer secret",
      }),
    );

    expect(resolved).toEqual({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          env: {
            LOG_LEVEL: "info",
            TOKEN: "secret-token",
          },
        },
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: {
            "x-client": "ptools",
            authorization: "Bearer secret",
          },
        },
      },
      executor: {
        defaultTimeoutMs: 1234,
      },
    });
  });

  it("fails when an env ref is missing", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          envFrom: {
            TOKEN: "MISSING_TOKEN",
          },
        },
      },
    });

    const result = await Effect.runPromise(
      resolvePtoolsConfig(config, {}).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("MISSING_TOKEN");
    }
  });

  it("fails invalid config shape", async () => {
    const result = await Effect.runPromise(
      parsePtoolsConfigJson(
        JSON.stringify({
          mcpServers: {
            bad: {
              transport: "websocket",
              url: "wss://example.com",
            },
          },
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
  });

  it("resolves config path from argv or env", async () => {
    await expect(
      Effect.runPromise(resolveConfigPath(["--config", "ptools.json"], {}, "/repo")),
    ).resolves.toBe("/repo/ptools.json");

    await expect(
      Effect.runPromise(resolveConfigPath([], { PTOOLS_CONFIG: "/tmp/x.json" }, "/repo")),
    ).resolves.toBe("/tmp/x.json");
  });
});

const parseConfig = (value: unknown) =>
  Effect.runPromise(parsePtoolsConfigJson(JSON.stringify(value)));
