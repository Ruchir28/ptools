import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCodeModeLive } from "@ptools/code-mode";
import { loadPtoolsConfig } from "@ptools/core";
import { makeLocalSandboxExecutorLive } from "@ptools/executor";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { startPlaygroundServer } from "../src/playground.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureServerPath = join(
  repoRoot,
  "packages/mcp-registry/test/fixtures/stdio-mcp-server.ts",
);

describe("Code Mode playground", () => {
  it("serves live context and executes through CodeMode", async () => {
    const configPath = await writeFixtureConfig();
    const config = await Effect.runPromise(
      loadPtoolsConfig(configPath, process.env),
    );
    const live = makeCodeModeLive().pipe(
      Layer.provide(
        Layer.merge(
          makeMcpRegistryLive(config.mcpServers),
          makeLocalSandboxExecutorLive(config.executor),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startPlaygroundServer({
            configPath,
            port: 0,
          });

          const page = yield* fetchText(`${started.url}/`);
          const context = yield* fetchJson<{
            readonly context: {
              readonly declarations: string;
              readonly servers: ReadonlyArray<{
                readonly jsServerName: string;
                readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
              }>;
            };
            readonly summary: {
              readonly serverCount: number;
              readonly toolCount: number;
              readonly diagnosticCount: number;
            };
          }>(`${started.url}/api/context`);
          const filtered = yield* fetchJson<typeof context>(
            `${started.url}/api/context?query=echo`,
          );
          const addDeclarations = yield* fetchJson<{
            readonly declarations: string;
          }>(
            `${started.url}/api/tool-declarations?server=fixture&tool=add`,
          );
          const execution = yield* fetchJson<{
            readonly value: unknown;
            readonly logs: ReadonlyArray<unknown>;
          }>(`${started.url}/api/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              code: `async () => {
                return await fixture.add({ a: 2, b: 3 });
              }`,
            }),
          });

          return { page, context, filtered, addDeclarations, execution };
        }).pipe(Effect.provide(live)),
      ),
    );

    expect(result.page).toContain("ptools MCP Playground");
    expect(result.context.summary).toEqual({
      serverCount: 1,
      toolCount: 2,
      diagnosticCount: 0,
    });
    expect(toToolKeys(result.context.context)).toEqual([
      "fixture.echo",
      "fixture.add",
    ]);
    expect(result.context.context.declarations).toContain(
      "declare namespace fixture",
    );
    expect(toToolKeys(result.filtered.context)).toEqual(["fixture.echo"]);
    expect(result.filtered.context.declarations).toContain("function echo");
    expect(result.filtered.context.declarations).not.toContain("function add");
    expect(result.addDeclarations.declarations).toContain("function add");
    expect(result.addDeclarations.declarations).toContain("FixtureAddInput");
    expect(result.addDeclarations.declarations).not.toContain("function echo");
    expect(result.execution).toEqual({
      value: { sum: 5 },
      logs: [],
    });
  }, 30_000);
});

const writeFixtureConfig = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "ptools-playground-"));
  const configPath = join(dir, "ptools.config.json");

  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx", fixtureServerPath],
          },
        },
      },
      null,
      2,
    ),
  );

  return configPath;
};

const fetchText = (url: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `GET ${url} failed with ${response.status}: ${await response.text()}`,
      );
    }

    return response.text();
  });

const fetchJson = <T>(
  url: string,
  init?: RequestInit,
): Effect.Effect<T> =>
  Effect.promise(async () => {
    const response = await fetch(url, init);

    if (!response.ok) {
      throw new Error(
        `${init?.method ?? "GET"} ${url} failed with ${response.status}: ${await response.text()}`,
      );
    }

    return (await response.json()) as T;
  });

const toToolKeys = (context: {
  readonly servers: ReadonlyArray<{
    readonly jsServerName: string;
    readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
  }>;
}): ReadonlyArray<string> =>
  context.servers.flatMap((server) =>
    server.tools.map((tool) => `${server.jsServerName}.${tool.jsToolName}`),
  );
