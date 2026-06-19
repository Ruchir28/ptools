import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCodeModeLive } from "@ptools/code-mode";
import { ConfigSource } from "@ptools/config";
import { LocalSandboxExecutorLayer } from "@ptools/host-node";
import {
  FileConfigSourceLive,
  NodeAuthCoordinatorLive,
  NodeCredentialsStoreLive,
  NodeMcpConnectorLive,
  ProcessEnvSecretResolverLive,
} from "@ptools/host-node";
import { makeMcpRegistryLive } from "@ptools/mcp-registry";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { startPlaygroundServer } from "../src/playground.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureServerPath = join(
  repoRoot,
  "packages/mcp-registry/test/fixtures/stdio-mcp-server.ts",
);

const makeNodeAuthCoordinatorLive = () =>
  NodeAuthCoordinatorLive({
    runtimeId: "test",
    autoOpen: false,
  }).pipe(
    Layer.provide(
      NodeCredentialsStoreLive({
        serviceName: "ptools-mcp-oauth-test",
      }),
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

describe.skipIf(!hasDeno)("Code Mode playground", () => {
  it("serves live context and executes through CodeMode", async () => {
    const configPath = await writeFixtureConfig();
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ConfigSource;

        return yield* source.load;
      }).pipe(
        Effect.provide(
          FileConfigSourceLive({ path: configPath }).pipe(
            Layer.provide(ProcessEnvSecretResolverLive({ env: process.env })),
          ),
        ),
      ),
    );
    const live = makeCodeModeLive().pipe(
      Layer.provide(
        Layer.merge(
          makeMcpRegistryLive(config.mcpServers).pipe(
            Layer.provide(NodeMcpConnectorLive),
            Layer.provide(makeNodeAuthCoordinatorLive()),
          ),
          LocalSandboxExecutorLayer(
            Option.match(config.executor, {
              onNone: () => undefined,
              onSome: (executor) =>
                Option.match(executor.defaultTimeoutMs, {
                  onNone: () => ({}),
                  onSome: (defaultTimeoutMs) => ({ defaultTimeoutMs }),
                }),
            }),
          ),
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
          const addSchema = yield* fetchJson<{
            readonly tools: ReadonlyArray<{
              readonly inputSchema: unknown;
            }>;
            readonly declarationsByServer: ReadonlyArray<{
              readonly declaration: string;
            }>;
          }>(`${started.url}/api/tool-schema`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              toolIds: ["fixture.add"],
            }),
          });
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

          return { page, context, filtered, addSchema, execution };
        }).pipe(Effect.provide(live)),
      ),
    );

    expect(result.page).toContain("ptools MCP Playground");
    expect(result.context.summary).toEqual({
      serverCount: 1,
      toolCount: 0,
      diagnosticCount: 0,
    });
    expect(toToolKeys(result.context.context)).toEqual([]);
    expect(result.context.context).not.toHaveProperty("declarations");
    expect(toToolKeys(result.filtered.context)).toEqual(["fixture.echo"]);
    expect(result.addSchema.tools[0]).not.toHaveProperty("declaration");
    expect(result.addSchema.declarationsByServer[0]?.declaration).toContain(
      "function add",
    );
    expect(result.addSchema.declarationsByServer[0]?.declaration).toContain(
      "FixtureAddInput",
    );
    expect(result.addSchema.declarationsByServer[0]?.declaration).not.toContain(
      "function echo",
    );
    expect(result.addSchema.tools[0]?.inputSchema).toEqual(
      expect.objectContaining({ type: "object" }),
    );
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

const fetchJson = <T>(url: string, init?: RequestInit): Effect.Effect<T> =>
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
