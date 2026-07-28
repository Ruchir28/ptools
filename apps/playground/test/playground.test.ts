/**
 * Playground HTTP carrier coverage over the shared CodeModeClient capability.
 *
 * What this proves:
 *   1. The playground consumes the client boundary rather than constructing a
 *      second Node runtime/config/auth graph.
 *   2. Context, schema, and execute routes project Code Mode responses.
 *
 * The playground HTTP server is real; the Host/Code Mode client is a focused
 * fake because daemon/HTTP vertical coverage belongs to host-node tests.
 */
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { startPlaygroundServer } from "../src/playground.js";

const CodeModeClientTest = Layer.succeed(
  CodeModeClient,
  CodeModeClient.of({
    call: (request) => {
      switch (request.operation) {
        case "search_providers":
          return Effect.succeed({
            operation: "search_providers" as const,
            output: {
              providers: [
                {
                  provider: "fixture",
                  displayName: "Fixture",
                  toolCount: 2,
                  exampleQueries: [],
                },
              ],
              diagnostics: [],
            },
          });
        case "search":
          return Effect.succeed({
            operation: "search" as const,
            output: {
              actions: [
                {
                  toolId: "fixture.echo",
                  provider: "fixture",
                  action: "echo",
                  call: "fixture.echo({})",
                  inputFields: [],
                },
              ],
              diagnostics: [],
            },
          });
        case "get_tool_schema":
          return Effect.succeed({
            operation: "get_tool_schema" as const,
            output: {
              tools: [
                {
                  serverName: "Fixture",
                  jsServerName: "fixture",
                  originalToolName: "add",
                  jsToolName: "add",
                  inputSchema: { type: "object" },
                },
              ],
              declarationsByServer: [
                {
                  serverName: "Fixture",
                  jsServerName: "fixture",
                  declaration: "interface FixtureAddInput {}\nfunction add(input: FixtureAddInput): Promise<unknown>;",
                },
              ],
              diagnostics: [],
            },
          });
        case "execute":
          return Effect.succeed({
            operation: "execute" as const,
            output: { value: { sum: 5 }, logs: [], warnings: [] },
          });
        case "auth_status":
          return Effect.die("unused auth_status");
        case "refresh":
          return Effect.die("unused refresh");
      }
    },
  }),
);

describe("Code Mode playground", () => {
  it("serves context, schema, and execution through CodeModeClient", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startPlaygroundServer({
            configPath: "fixture config",
            port: 0,
          });
          const page = yield* fetchText(`${started.url}/`);
          const context = yield* fetchJson<{
            readonly summary: { readonly serverCount: number; readonly toolCount: number };
          }>(`${started.url}/api/context`);
          const filtered = yield* fetchJson<{
            readonly context: {
              readonly servers: ReadonlyArray<{
                readonly jsServerName: string;
                readonly tools: ReadonlyArray<{ readonly jsToolName: string }>;
              }>;
            };
          }>(`${started.url}/api/context?query=echo`);
          const schema = yield* fetchJson<{
            readonly declarationsByServer: ReadonlyArray<{ readonly declaration: string }>;
          }>(`${started.url}/api/tool-schema`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ toolIds: ["fixture.add"] }),
          });
          const execution = yield* fetchJson<unknown>(
            `${started.url}/api/execute`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ code: "async () => 5" }),
            },
          );
          return { page, context, filtered, schema, execution };
        }).pipe(Effect.provide(CodeModeClientTest)),
      ),
    );

    expect(result.page).toContain("ptools MCP Playground");
    expect(result.context.summary).toMatchObject({ serverCount: 1, toolCount: 0 });
    expect(toToolKeys(result.filtered.context)).toEqual(["fixture.echo"]);
    expect(result.schema.declarationsByServer[0]?.declaration).toContain(
      "FixtureAddInput",
    );
    expect(result.execution).toEqual({
      value: { sum: 5 },
      logs: [],
      warnings: [],
    });
  });
});

const fetchText = (url: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} failed: ${await response.text()}`);
    return response.text();
  });

const fetchJson = <T>(url: string, init?: RequestInit): Effect.Effect<T> =>
  Effect.promise(async () => {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${await response.text()}`);
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
