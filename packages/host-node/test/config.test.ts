import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResolvedPtoolsConfigSource,
  ServerConfigError,
  type ResolvedPtoolsConfig,
} from "@ptools/config";
import { Effect, Either, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  FileResolvedPtoolsConfigSourceLive,
  NodeResolvedPtoolsConfigSourceLive,
} from "../src/index.js";

describe("node config loading", () => {
  it("loads config files and resolves relative stdio cwd from the config file directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptools-host-node-config-"));
    const configPath = join(dir, "ptools.config.json");

    await writeConfig(configPath, {
      mcpServers: {
        fixture: {
          command: "node",
          cwd: "servers",
        },
      },
    });

    const resolved = await Effect.runPromise(
      loadProvidedConfig(
        FileResolvedPtoolsConfigSourceLive({ path: configPath }),
      ),
    );

    const fixture = resolved.mcpServers.fixture;

    if (fixture?.transport !== "stdio") {
      throw new Error("Expected fixture to resolve as stdio");
    }

    expect(fixture.cwd).toEqual(Option.some(join(dir, "servers")));
  });

  it("resolves config path from argv, env, or default project files through NodeResolvedPtoolsConfigSourceLive", async () => {
    const cliDir = await mkdtemp(join(tmpdir(), "ptools-host-node-cli-"));
    await writeConfig(join(cliDir, "ptools.json"), {
      mcpServers: { cli: { command: "node" } },
    });

    await expect(
      Effect.runPromise(
        loadProvidedConfig(
          NodeResolvedPtoolsConfigSourceLive({
            argv: ["--config", "ptools.json"],
            env: {},
            cwd: cliDir,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      mcpServers: { cli: { command: "node" } },
    });

    const envDir = await mkdtemp(join(tmpdir(), "ptools-host-node-env-"));
    const envConfigPath = join(envDir, "env.json");
    await writeConfig(envConfigPath, {
      mcpServers: { env: { command: "node" } },
    });

    await expect(
      Effect.runPromise(
        loadProvidedConfig(
          NodeResolvedPtoolsConfigSourceLive({
            argv: [],
            env: { PTOOLS_CONFIG: envConfigPath },
            cwd: envDir,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      mcpServers: { env: { command: "node" } },
    });

    const defaultDir = await mkdtemp(
      join(tmpdir(), "ptools-host-node-default-"),
    );
    await mkdir(join(defaultDir, ".ptools"));
    await writeConfig(join(defaultDir, ".ptools", "config.json"), {
      mcpServers: { preferred: { command: "node" } },
    });
    await writeConfig(join(defaultDir, "ptools.config.json"), {
      mcpServers: { legacy: { command: "node" } },
    });

    await expect(
      Effect.runPromise(
        loadProvidedConfig(
          NodeResolvedPtoolsConfigSourceLive({
            argv: [],
            env: {},
            cwd: defaultDir,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      mcpServers: { preferred: { command: "node" } },
    });

    const legacyDir = await mkdtemp(join(tmpdir(), "ptools-host-node-legacy-"));
    await writeConfig(join(legacyDir, "ptools.config.json"), {
      mcpServers: { legacy: { command: "node" } },
    });

    await expect(
      Effect.runPromise(
        loadProvidedConfig(
          NodeResolvedPtoolsConfigSourceLive({
            argv: [],
            env: {},
            cwd: legacyDir,
          }),
        ),
      ),
    ).resolves.toMatchObject({
      mcpServers: { legacy: { command: "node" } },
    });
  });

  it("fails clearly when no config path can be resolved", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "ptools-host-node-missing-config-"),
    );

    const result = await Effect.runPromise(
      loadProvidedConfig(
        NodeResolvedPtoolsConfigSourceLive({
          argv: [],
          env: {},
          cwd: dir,
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ServerConfigError);
      expect(result.left.message).toContain(".ptools/config.json");
    }
  });

  it("provides explicit env secrets through FileResolvedPtoolsConfigSourceLive", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "ptools-host-node-config-source-"),
    );
    const configPath = join(dir, "ptools.config.json");

    await writeConfig(configPath, {
      mcpServers: {
        fixture: {
          command: "${env:NODE_BIN}",
        },
      },
    });

    const resolved = await Effect.runPromise(
      loadProvidedConfig(
        FileResolvedPtoolsConfigSourceLive({
          path: configPath,
          env: { NODE_BIN: "node" },
        }),
      ),
    );

    expect(resolved.mcpServers.fixture).toMatchObject({
      transport: "stdio",
      command: "node",
    });
  });
});

const loadProvidedConfig = <E, R>(
  layer: Layer.Layer<ResolvedPtoolsConfigSource, E, R>,
): Effect.Effect<ResolvedPtoolsConfig, E | ServerConfigError, R> =>
  Effect.gen(function* () {
    const source = yield* ResolvedPtoolsConfigSource;

    return yield* source.load;
  }).pipe(Effect.provide(layer));

const writeConfig = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value));
