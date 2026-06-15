import { join } from "node:path";
import { Effect, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  hashResolvedPtoolsConfig,
  parsePtoolsConfigJson,
  PtoolsConfig,
  ResolvedExecutorConfig,
  ResolvedHttpMcpAuthConfig,
  ResolvedHttpMcpConfig,
  ResolvedPtoolsConfig,
  ResolvedStdioMcpConfig,
  resolvePtoolsConfig,
  resolvePtoolsConfigWithSecrets,
  ServerConfigError,
  SecretResolver,
} from "../src/config.js";

describe("server config", () => {
  it("requires validated construction for the PtoolsConfig domain value", () => {
    // @ts-expect-error Plain objects must not satisfy the validated config type.
    const plainConfig: PtoolsConfig = { mcpServers: {} };

    expect(plainConfig).toEqual({ mcpServers: {} });
    expect(
      PtoolsConfig.make({ mcpServers: {}, executor: Option.none() }),
    ).toBeInstanceOf(PtoolsConfig);
  });

  it("encodes resolved domain classes into plain boundary objects", async () => {
    const resolved = ResolvedPtoolsConfig.make({
      mcpServers: {
        remote: ResolvedHttpMcpConfig.make({
          url: "https://example.com/mcp",
          headers: Option.none(),
          auth: Option.none(),
        }),
      },
      executor: Option.none(),
    });

    const encoded = await Effect.runPromise(
      Schema.encode(ResolvedPtoolsConfig)(resolved),
    );

    expect(encoded).toEqual({
      mcpServers: {
        remote: {
          transport: "http",
          url: "https://example.com/mcp",
        },
      },
    });
  });

  it("decodes executor absence into Option.none", async () => {
    const config = await parseConfig({ mcpServers: {} });

    expect(config).toBeInstanceOf(PtoolsConfig);
    expect(config.executor).toEqual(Option.none());
  });

  it("decodes optional unresolved config fields into Options", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: { command: "node" },
        remote: { url: "https://example.com/mcp" },
      },
    });

    expect(config.mcpServers.local).toMatchObject({
      transport: "stdio",
      args: Option.none(),
      cwd: Option.none(),
      env: Option.none(),
    });
    expect(config.mcpServers.remote).toMatchObject({
      transport: "http",
      headers: Option.none(),
      auth: Option.none(),
    });
  });

  it("exposes the normalized unresolved config as a runtime schema", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(PtoolsConfig)({
        mcpServers: {
          remote: {
            transport: "http",
            url: 42,
          },
        },
      }).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
  });

  it("validates package-owned config construction", () => {
    expect(() =>
      PtoolsConfig.make({
        mcpServers: {
          remote: {
            transport: "http",
            url: 42,
          },
        },
      } as never),
    ).toThrow();
  });

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

    expect(resolved).toEqual(
      ResolvedPtoolsConfig.make({
        mcpServers: {
          fixture: ResolvedStdioMcpConfig.make({
            command: "node",
            args: Option.some(["server.js"]),
            cwd: Option.some("/tmp"),
            env: Option.none(),
          }),
        },
        executor: Option.none(),
      }),
    );
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

    expect(resolved).toEqual(
      ResolvedPtoolsConfig.make({
        mcpServers: {
          docs: ResolvedHttpMcpConfig.make({
            url: "https://example.com/mcp",
            headers: Option.none(),
            auth: Option.none(),
          }),
        },
        executor: Option.none(),
      }),
    );
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

    expect(stdioServer(resolved, "local").env).toEqual(
      Option.some({ LOG_LEVEL: "debug" }),
    );
    expect(httpServer(resolved, "remote").headers).toEqual(
      Option.some({ "x-client": "ptools" }),
    );
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

    expect(resolved).toEqual(
      ResolvedPtoolsConfig.make({
        mcpServers: {
          local: ResolvedStdioMcpConfig.make({
            command: "node",
            args: Option.some(["server.js"]),
            env: Option.some({
              LOG_LEVEL: "info",
              TOKEN: "secret-token",
            }),
            cwd: Option.none(),
          }),
          remote: ResolvedHttpMcpConfig.make({
            url: "https://example.com/mcp",
            headers: Option.some({
              "x-client": "ptools",
              authorization: "Bearer secret",
            }),
            auth: Option.none(),
          }),
        },
        executor: Option.some(
          ResolvedExecutorConfig.make({
            defaultTimeoutMs: Option.some(1234),
          }),
        ),
      }),
    );
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

    expect(resolved.mcpServers.notion).toEqual(
      ResolvedHttpMcpConfig.make({
        url: "https://example.com/mcp",
        headers: Option.none(),
        auth: Option.some(
          ResolvedHttpMcpAuthConfig.make({
            type: "oauth",
            scope: Option.some("read write"),
            resourceMetadataUrl: Option.some(
              "https://example.com/.well-known/oauth-protected-resource",
            ),
            clientId: Option.some("client-id"),
            clientSecret: Option.some("secret"),
            clientMetadataUrl: Option.some("https://example.com/client.json"),
            redirectUri: Option.some(
              "http://127.0.0.1:9000/oauth/callback/notion",
            ),
          }),
        ),
      }),
    );
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

  it("resolves env placeholders through SecretResolver service", async () => {
    const config = await parseConfig({
      mcpServers: {
        local: {
          command: "${env:NODE_BIN}",
          env: {
            TOKEN: "${env:SOURCE_TOKEN}",
          },
        },
      },
    });

    const resolved = await Effect.runPromise(
      resolvePtoolsConfigWithSecrets(config).pipe(
        Effect.provideService(SecretResolver, {
          get: (name) =>
            Effect.succeed(
              {
                NODE_BIN: "node",
                SOURCE_TOKEN: "secret-token",
              }[name] ?? "",
            ),
        }),
      ),
    );

    expect(stdioServer(resolved, "local").command).toBe("node");
    expect(stdioServer(resolved, "local").env).toEqual(
      Option.some({ TOKEN: "secret-token" }),
    );
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

  it("rejects transport and type fields outside the user config schema", async () => {
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
        expect(result.left.message).toContain(field);
        expect(result.left.message).toContain("is unexpected");
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
      expect(result.left.message).toContain("is unexpected");
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

  it("resolves relative stdio cwd values from the supplied base directory", async () => {
    const config = await parseConfig({
      mcpServers: {
        fixture: {
          command: "node",
          cwd: "servers",
        },
      },
    });

    const resolved = await Effect.runPromise(
      resolvePtoolsConfig(config, {}, { baseDir: "/repo" }),
    );

    expect(stdioServer(resolved, "fixture").cwd).toEqual(
      Option.some(join("/repo", "servers")),
    );
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

  it("hashes resolved configs deterministically", () => {
    expect(
      hashResolvedPtoolsConfig(
        ResolvedPtoolsConfig.make({
          mcpServers: {
            remote: ResolvedHttpMcpConfig.make({
              url: "https://example.com/mcp",
              headers: Option.some({
                b: "2",
                a: "1",
              }),
              auth: Option.none(),
            }),
          },
          executor: Option.none(),
        }),
      ),
    ).toBe(
      hashResolvedPtoolsConfig(
        ResolvedPtoolsConfig.make({
          mcpServers: {
            remote: ResolvedHttpMcpConfig.make({
              headers: Option.some({
                a: "1",
                b: "2",
              }),
              url: "https://example.com/mcp",
              auth: Option.none(),
            }),
          },
          executor: Option.none(),
        }),
      ),
    );
  });
});

const parseConfig = (value: unknown) =>
  Effect.runPromise(parsePtoolsConfigJson(JSON.stringify(value)));

const stdioServer = (
  config: ResolvedPtoolsConfig,
  name: string,
): ResolvedStdioMcpConfig => {
  const server = config.mcpServers[name];

  if (!(server instanceof ResolvedStdioMcpConfig)) {
    throw new Error(`Expected ${name} to be a resolved stdio config`);
  }

  return server;
};

const httpServer = (
  config: ResolvedPtoolsConfig,
  name: string,
): ResolvedHttpMcpConfig => {
  const server = config.mcpServers[name];

  if (!(server instanceof ResolvedHttpMcpConfig)) {
    throw new Error(`Expected ${name} to be a resolved HTTP config`);
  }

  return server;
};
