import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result, Layer, Option, Schema } from "effect";
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
  ConfiguredSecretStore,
} from "../src/config.js";
import {
  CONFIGURED_HOST_CONFIG_BLOB_KEY,
  ConfiguredHostConfigStore,
  HostSecretStorage,
  HostSecretStorageBackend,
  HostStateStorage,
  HostStateStorageBackend,
  ResolvedPtoolsConfigSource,
  type HostStorageOperations,
} from "../src/services/index.js";
import { HostIdentityLayer } from "@ptools/host-context";
import {
  collectUserPtoolsConfigEnvReferences,
  normalizeUserPtoolsConfigStdioCwds,
  parseUserPtoolsConfigJson,
} from "../src/authoredConfigBootstrap.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("authored Host API bootstrap helpers", () => {
  it("anchors stdio cwd and selects only referenced environment names", async () => {
    const authored = await Effect.runPromise(
      parseUserPtoolsConfigJson(
        JSON.stringify({
          mcpServers: {
            local: {
              command: "${env:NODE_BIN}",
              cwd: "servers",
              env: { TOKEN: "Bearer ${env:API_TOKEN}" },
            },
            remote: {
              url: "https://${env:REMOTE_HOST}/mcp",
              cwd: "must-not-be-used",
            },
            disabled: {
              command: "${env:IGNORED_BIN}",
              disabled: true,
            },
          },
        }),
        "/repo/config/ptools.json",
      ),
    );
    const normalized = normalizeUserPtoolsConfigStdioCwds(
      authored,
      (cwd) => `/repo/config/${cwd}`,
    );

    expect(Option.getOrUndefined(normalized.mcpServers.local!.cwd)).toBe(
      "/repo/config/servers",
    );
    expect(Option.getOrUndefined(normalized.mcpServers.remote!.cwd)).toBe(
      "must-not-be-used",
    );
    expect(collectUserPtoolsConfigEnvReferences(normalized)).toEqual([
      "API_TOKEN",
      "NODE_BIN",
      "REMOTE_HOST",
    ]);
  });
});

describe("host storage construction", () => {
  it("selects the backend with HostIdentity and publishes that host ID", async () => {
    const storage = makeMemoryHostStorage();
    let requestedHostId: string | undefined;
    const layer = HostStateStorage.layer.pipe(
      Layer.provide(
        Layer.merge(
          HostIdentityLayer("host-a"),
          Layer.succeed(HostStateStorageBackend, {
            forHost: (hostId) => {
              requestedHostId = hostId;
              return Effect.succeed(storage);
            },
          }),
        ),
      ),
    );

    const hostId = await Effect.runPromise(
      Effect.gen(function* () {
        const selected = yield* HostStateStorage;
        return selected.hostId;
      }).pipe(Effect.provide(layer)),
    );

    expect(requestedHostId).toBe("host-a");
    expect(hostId).toBe("host-a");
  });
});

describe("config source layout", () => {
  it("keeps contracts and Effect services in semantic source folders", async () => {
    for (const contractFile of [
      "authoredPtoolsConfig.ts",
      "normalizedPtoolsConfig.ts",
      "ptoolsSecretValues.ts",
      "resolvedPtoolsConfig.ts",
      "index.ts",
    ]) {
      await expect(
        fileExists(join(packageRoot, "src/contracts", contractFile)),
      ).resolves.toBe(true);
    }

    await expect(
      fileExists(join(packageRoot, "src/services/configServices.ts")),
    ).resolves.toBe(true);
    await expect(
      fileExists(join(packageRoot, "src/services/hostStorage.ts")),
    ).resolves.toBe(true);
    await expect(
      fileExists(join(packageRoot, "src/services/configuredSecrets.ts")),
    ).resolves.toBe(true);
    await expect(
      fileExists(join(packageRoot, "src/services/configuredHostConfig.ts")),
    ).resolves.toBe(true);

    await expect(
      fileExists(join(packageRoot, "src/contracts/ptoolsConfig.ts")),
    ).resolves.toBe(false);
    await expect(fileExists(join(packageRoot, "src/effect"))).resolves.toBe(
      false,
    );
  });

  it("keeps shared host storage and configured-secret services platform-free", async () => {
    const sources = await Promise.all([
      readFile(join(packageRoot, "src/services/hostStorage.ts"), "utf8"),
      readFile(join(packageRoot, "src/services/configuredSecrets.ts"), "utf8"),
      readFile(
        join(packageRoot, "src/services/configuredHostConfig.ts"),
        "utf8",
      ),
    ]);

    for (const source of sources) {
      expect(source).not.toMatch(
        /from\s+["'][^"']*(cloudflare|hono|host-cloudflare|host-node|cloudflare:workers|@cloudflare|@effect\/platform|@napi-rs\/keyring)[^"']*["']/,
      );
    }
  });
});

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
      Schema.encodeEffect(ResolvedPtoolsConfig)(resolved),
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
      Schema.decodeUnknownEffect(PtoolsConfig)({
        mcpServers: {
          remote: {
            transport: "http",
            url: 42,
          },
        },
      }).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
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
      resolvePtoolsConfig(config, {}).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("MISSING_TOKEN");
      expect(result.failure).toBeInstanceOf(ServerConfigError);
    }
  });

  it("resolves env placeholders through ConfiguredSecretStore", async () => {
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

    const storage = makeMemoryHostStorage();
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ConfiguredSecretStore;
        yield* store.replaceAll({
          secrets: {
            NODE_BIN: "node",
            SOURCE_TOKEN: "secret-token",
          },
        });
      }).pipe(Effect.provide(configuredSecretStoreTestLayer(storage))),
    );

    const resolved = await Effect.runPromise(
      resolvePtoolsConfigWithSecrets(config).pipe(
        Effect.provide(configuredSecretStoreTestLayer(storage)),
      ),
    );

    expect(stdioServer(resolved, "local").command).toBe("node");
    expect(stdioServer(resolved, "local").env).toEqual(
      Option.some({ TOKEN: "secret-token" }),
    );
  });

  it("provides a shared resolved config source from configured host storage", async () => {
    const storage = makeMemoryHostStorage();
    const unresolvedConfig = await parseConfig({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer ${env:API_TOKEN}",
          },
        },
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const configStore = yield* ConfiguredHostConfigStore;
        const secretStore = yield* ConfiguredSecretStore;
        yield* configStore.replace({ config: unresolvedConfig });
        yield* secretStore.replaceAll({
          secrets: { API_TOKEN: "stored-token" },
        });
      }).pipe(Effect.provide(configuredHostStoreTestLayer(storage))),
    );

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ResolvedPtoolsConfigSource;
        return yield* source.load;
      }).pipe(
        Effect.provide(configuredHostResolvedConfigSourceTestLayer(storage)),
      ),
    );

    expect(httpServer(resolved, "remote").headers).toEqual(
      Option.some({ Authorization: "Bearer stored-token" }),
    );
  });

  it("loads the newest secret value without replacing stored config", async () => {
    const storage = makeMemoryHostStorage();
    const unresolvedConfig = await parseConfig({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${env:API_TOKEN}" },
        },
      },
    });
    const stores = configuredHostStoreTestLayer(storage);
    await Effect.runPromise(
      Effect.gen(function* () {
        const configStore = yield* ConfiguredHostConfigStore;
        const secretStore = yield* ConfiguredSecretStore;
        yield* configStore.replace({ config: unresolvedConfig });
        yield* secretStore.replaceAll({ secrets: { API_TOKEN: "first" } });
      }).pipe(Effect.provide(stores)),
    );

    const load = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const source = yield* ResolvedPtoolsConfigSource;
          return yield* source.load;
        }).pipe(
          Effect.provide(configuredHostResolvedConfigSourceTestLayer(storage)),
        ),
      );
    expect(httpServer(await load(), "remote").headers).toEqual(
      Option.some({ Authorization: "Bearer first" }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const secretStore = yield* ConfiguredSecretStore;
        yield* secretStore.replaceAll({ secrets: { API_TOKEN: "rotated" } });
      }).pipe(Effect.provide(stores)),
    );
    expect(httpServer(await load(), "remote").headers).toEqual(
      Option.some({ Authorization: "Bearer rotated" }),
    );
  });

  it("fails resolved-config loading with the exact missing-secret error", async () => {
    const storage = makeMemoryHostStorage();
    const unresolvedConfig = await parseConfig({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${env:MISSING_TOKEN}" },
        },
      },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ConfiguredHostConfigStore;
        yield* store.replace({ config: unresolvedConfig });
      }).pipe(Effect.provide(configuredHostStoreTestLayer(storage))),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ResolvedPtoolsConfigSource;
        return yield* Effect.result(source.load);
      }).pipe(
        Effect.provide(configuredHostResolvedConfigSourceTestLayer(storage)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ServerConfigError);
      expect(result.failure.message).toBe(
        "Missing environment variable MISSING_TOKEN for headers.Authorization on MCP server remote",
      );
    }
  });

  it("fails resolved-config loading when persisted config is malformed", async () => {
    const storage = makeMemoryHostStorage();
    await Effect.runPromise(
      storage.put(
        CONFIGURED_HOST_CONFIG_BLOB_KEY,
        JSON.stringify({
          config: {
            mcpServers: {
              remote: { transport: "http", url: 42 },
            },
          },
          updatedAt: new Date().toISOString(),
          serverCount: 1,
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ResolvedPtoolsConfigSource;
        return yield* Effect.result(source.load);
      }).pipe(
        Effect.provide(configuredHostResolvedConfigSourceTestLayer(storage)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ServerConfigError);
      expect(result.failure.message).toBe(
        "Stored configured host config is invalid.",
      );
    }
  });

  it("replaces configured secret sets and deletes stale values", async () => {
    const storage = makeMemoryHostStorage();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ConfiguredSecretStore;
        yield* store.replaceAll({
          secrets: {
            KEEP: "first",
            STALE: "old",
          },
        });
        const replacement = yield* store.replaceAll({
          secrets: {
            KEEP: "second",
            NEW: "new",
          },
        });
        const keep = yield* store.get("KEEP");
        const newest = yield* store.get("NEW");
        const stale = yield* store.get("STALE").pipe(Effect.result);

        return { replacement, keep, newest, stale };
      }).pipe(Effect.provide(configuredSecretStoreTestLayer(storage))),
    );

    expect(result.replacement.secretCount).toBe(2);
    expect(result.keep).toBe("second");
    expect(result.newest).toBe("new");
    expect(Result.isFailure(result.stale)).toBe(true);
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
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("not both");
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
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("must provide command");
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
        ).pipe(Effect.result),
      );

      expect(Result.isFailure(result), field).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure.message).toContain(field);
        expect(result.failure.message).toContain("Unexpected key");
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
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("envFile");
      expect(result.failure.message).toContain("Unexpected key");
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
      ).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);
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

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const makeMemoryHostStorage = (): HostStorageOperations => {
  const values = new Map<string, string>();

  return {
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    put: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    delete: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  };
};

const hostStorageTestLayer = (storage: HostStorageOperations) =>
  Layer.merge(HostStateStorage.layer, HostSecretStorage.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        HostIdentityLayer("test-host"),
        Layer.succeed(HostStateStorageBackend, {
          forHost: () => Effect.succeed(storage),
        }),
        Layer.succeed(HostSecretStorageBackend, {
          forHost: () => Effect.succeed(storage),
        }),
      ),
    ),
  );

const configuredSecretStoreTestLayer = (storage: HostStorageOperations) =>
  ConfiguredSecretStore.layer.pipe(
    Layer.provide(hostStorageTestLayer(storage)),
  );

const configuredHostStoreTestLayer = (storage: HostStorageOperations) =>
  Layer.merge(
    ConfiguredHostConfigStore.layer,
    ConfiguredSecretStore.layer,
  ).pipe(Layer.provide(hostStorageTestLayer(storage)));

const configuredHostResolvedConfigSourceTestLayer = (
  storage: HostStorageOperations,
) =>
  ResolvedPtoolsConfigSource.layer.pipe(
    Layer.provide(ConfiguredHostConfigStore.layer),
    Layer.provide(ConfiguredSecretStore.layer),
    Layer.provide(hostStorageTestLayer(storage)),
  );

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
