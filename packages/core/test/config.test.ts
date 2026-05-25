import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  loadPtoolsConfig,
  parsePtoolsConfigJson,
  resolveConfigPath,
  resolvePtoolsConfig,
  ServerConfigError,
} from "../src/config.js";

describe("server config", () => {
  it("resolves valid stdio config to registry-compatible config", async () => {
    const config = await parseConfig({
      mcpServers: {
        fixture: {
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
          command: "node",
          env: {
            LOG_LEVEL: "debug",
          },
        },
        remote: {
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

  it("resolves env placeholders in string fields", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: {
          command: "${env:NODE_BIN}",
          args: ["${env:SERVER_FILE}"],
          env: {
            LOG_LEVEL: "info",
            TOKEN: "${env:SOURCE_TOKEN}",
          },
        },
        remote: {
          url: "https://${env:REMOTE_HOST}/mcp",
          headers: {
            "x-client": "ptools",
            authorization: "Bearer ${env:REMOTE_AUTH}",
          },
        },
      },
      executor: {
        defaultTimeoutMs: 1234,
      },
    });

    const resolved = await Effect.runPromise(
      resolvePtoolsConfig(config, {
        NODE_BIN: "node",
        SERVER_FILE: "server.js",
        SOURCE_TOKEN: "secret-token",
        REMOTE_HOST: "example.com",
        REMOTE_AUTH: "secret",
      }),
    );

    expect(resolved).toEqual({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
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

  it("resolves env placeholders in HTTP OAuth config", async () => {
    const config = await parseConfig({
      mcpServers: {
        notion: {
          url: "https://example.com/mcp",
          auth: {
            type: "oauth",
            scope: "read write",
            resourceMetadataUrl:
              "https://example.com/.well-known/oauth-protected-resource",
            clientId: "client-id",
            clientSecret: "${env:OAUTH_CLIENT_SECRET}",
            clientMetadataUrl: "https://example.com/client.json",
            redirectUri: "http://127.0.0.1:9000/oauth/callback/notion",
          },
        },
      },
    });

    const resolved = await Effect.runPromise(
      resolvePtoolsConfig(config, { OAUTH_CLIENT_SECRET: "secret" }),
    );

    expect(resolved.mcpServers.notion).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      auth: {
        type: "oauth",
        scope: "read write",
        resourceMetadataUrl:
          "https://example.com/.well-known/oauth-protected-resource",
        clientId: "client-id",
        clientSecret: "secret",
        clientMetadataUrl: "https://example.com/client.json",
        redirectUri: "http://127.0.0.1:9000/oauth/callback/notion",
      },
    });
  });

  it("fails when an env placeholder is missing", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: {
          command: "node",
          env: {
            TOKEN: "${env:MISSING_TOKEN}",
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
      expect(result.left).toBeInstanceOf(ServerConfigError);
    }
  });

  it("infers stdio and HTTP transport from command and url", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: { command: "node" },
        remote: { url: "https://example.com/mcp" },
      },
    });

    const resolved = await Effect.runPromise(resolvePtoolsConfig(config, {}));

    expect(resolved.mcpServers.local).toMatchObject({ transport: "stdio" });
    expect(resolved.mcpServers.remote).toMatchObject({ transport: "http" });
  });

  it("fails when both command and url are present", async () => {
    const result = await Effect.runPromise(
      parsePtoolsConfigJson(
        JSON.stringify({
          mcpServers: {
            bad: {
              command: "node",
              url: "https://example.com/mcp",
            },
          },
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("not both");
    }
  });

  it("fails when neither command nor url is present", async () => {
    const result = await Effect.runPromise(
      parsePtoolsConfigJson(
        JSON.stringify({
          mcpServers: {
            bad: {
              args: ["server.js"],
            },
          },
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("must provide command");
    }
  });

  it("rejects transport and type fields clearly", async () => {
    for (const field of ["transport", "type"]) {
      const result = await Effect.runPromise(
        parsePtoolsConfigJson(
          JSON.stringify({
            mcpServers: {
              bad: {
                [field]: "stdio",
                command: "node",
              },
            },
          }),
        ).pipe(Effect.either),
      );

      expect(Either.isLeft(result), field).toBe(true);

      if (Either.isLeft(result)) {
        expect(result.left.message).toContain("use command");
        expect(result.left.message).toContain("url");
      }
    }
  });

  it("rejects unsupported behavior-altering copied fields", async () => {
    const result = await Effect.runPromise(
      parsePtoolsConfigJson(
        JSON.stringify({
          mcpServers: {
            bad: {
              command: "node",
              envFile: ".env",
            },
          },
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);

    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("envFile");
      expect(result.left.message).toContain("not supported");
    }
  });

  it("accepts neutral enabled and disabled fields", async () => {
    const config = await parseConfig({
      mcpServers: {
        a: { command: "node", disabled: false },
        b: { url: "https://example.com/mcp", enabled: true },
      },
    });

    expect(Object.keys(config.mcpServers)).toEqual(["a", "b"]);
  });

  it("excludes disabled servers", async () => {
    const config = await parseConfig({
      mcpServers: {
        enabled: { command: "node" },
        disabled: { command: "node", disabled: true },
        notEnabled: { url: "https://example.com/mcp", enabled: false },
      },
    });

    const resolved = await Effect.runPromise(resolvePtoolsConfig(config, {}));

    expect(Object.keys(resolved.mcpServers)).toEqual(["enabled"]);
  });

  it("resolves relative stdio cwd values from the config file directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-core-config-"));
    const configPath = join(dir, "ptools.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: "node",
            cwd: "servers",
          },
        },
      }),
    );

    const resolved = await Effect.runPromise(loadPtoolsConfig(configPath, {}));

    expect(resolved.mcpServers.fixture).toMatchObject({
      cwd: join(dir, "servers"),
    });
  });

  it("fails invalid config shape", async () => {
    const result = await Effect.runPromise(
      parsePtoolsConfigJson(
        JSON.stringify({
          mcpServers: {
            bad: {
              url: 42,
            },
          },
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
  });

  it("resolves config path from argv, env, or default project files", async () => {
    await expect(
      Effect.runPromise(
        resolveConfigPath(["--config", "ptools.json"], {}, "/repo"),
      ),
    ).resolves.toBe("/repo/ptools.json");

    await expect(
      Effect.runPromise(
        resolveConfigPath([], { PTOOLS_CONFIG: "/tmp/x.json" }, "/repo"),
      ),
    ).resolves.toBe("/tmp/x.json");

    const dir = await mkdtemp(join(tmpdir(), "ptools-core-config-path-"));
    await mkdir(join(dir, ".ptools"));
    await writeFile(join(dir, ".ptools", "config.json"), "{}");
    await writeFile(join(dir, "ptools.config.json"), "{}");

    await expect(
      Effect.runPromise(resolveConfigPath([], {}, dir)),
    ).resolves.toBe(join(dir, ".ptools", "config.json"));

    const legacyDir = await mkdtemp(
      join(tmpdir(), "ptools-core-config-legacy-"),
    );
    await writeFile(join(legacyDir, "ptools.config.json"), "{}");

    await expect(
      Effect.runPromise(resolveConfigPath([], {}, legacyDir)),
    ).resolves.toBe(join(legacyDir, "ptools.config.json"));
  });

  it("fails clearly when no config path can be resolved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-core-missing-config-"));

    const result = await Effect.runPromise(
      resolveConfigPath([], {}, dir).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ServerConfigError);
      expect(result.left.message).toContain(".ptools/config.json");
    }
  });
});

const parseConfig = (value: unknown) =>
  Effect.runPromise(parsePtoolsConfigJson(JSON.stringify(value)));
