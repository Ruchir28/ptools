import {
  CodeModeExecuteRequest,
  CodeModeSearchProvidersRequest,
  CodeModeSearchRequest,
  CodeModeServer,
  CodeModeToolSchemaRequest,
} from "@ptools/code-mode-api";
import { CodeMode } from "@ptools/code-mode";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CloudflareCodeModeServerLayer } from "../src/layers/codeModeServer.js";

describe("CloudflareCodeModeServerLayer", () => {
  it("dispatches every Code Mode API operation to the configured CodeMode service", async () => {
    const calls: Array<string> = [];

    const responses = await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* CodeModeServer;

        return {
          authStatus: yield* server.handle({ operation: "auth_status" }),
          refresh: yield* server.handle({ operation: "refresh" }),
          searchProviders: yield* server.handle({
            operation: "search_providers",
            input: CodeModeSearchProvidersRequest.make({
              query: Option.none(),
              limit: Option.none(),
            }),
          }),
          search: yield* server.handle({
            operation: "search",
            input: CodeModeSearchRequest.make({
              query: "find",
              provider: Option.none(),
              limit: Option.none(),
            }),
          }),
          toolSchema: yield* server.handle({
            operation: "get_tool_schema",
            input: CodeModeToolSchemaRequest.make({ toolIds: ["demo.echo"] }),
          }),
          execute: yield* server.handle({
            operation: "execute",
            input: CodeModeExecuteRequest.make({
              code: "return 1;",
              timeoutMs: Option.none(),
            }),
          }),
        };
      }).pipe(
        Effect.provide(
          CloudflareCodeModeServerLayer.pipe(
            Layer.provide(makeRecordingCodeModeLayer(calls)),
          ),
        ),
      ),
    );

    expect(calls).toEqual([
      "authStatus",
      "refresh",
      "searchProviders",
      "search",
      "toolSchema",
      "execute",
    ]);
    expect(responses).toMatchObject({
      authStatus: { operation: "auth_status" },
      refresh: { operation: "refresh", output: { refreshed: true } },
      searchProviders: { operation: "search_providers" },
      search: { operation: "search" },
      toolSchema: { operation: "get_tool_schema" },
      execute: { operation: "execute" },
    });
  });
});

const makeRecordingCodeModeLayer = (calls: Array<string>) =>
  Layer.succeed(CodeMode, {
    diagnostics: Effect.succeed([]),
    authStatus: Effect.sync(() => {
      calls.push("authStatus");
      return {
        authUrl: "https://ptools.example/hosts/demo/auth",
        servers: [],
      };
    }),
    refresh: Effect.sync(() => {
      calls.push("refresh");
    }),
    searchProviders: () =>
      Effect.sync(() => {
        calls.push("searchProviders");
        return { providers: [], diagnostics: [] };
      }),
    search: () =>
      Effect.sync(() => {
        calls.push("search");
        return { actions: [], diagnostics: [] };
      }),
    toolSchema: () =>
      Effect.sync(() => {
        calls.push("toolSchema");
        return { tools: [], declarationsByServer: [], diagnostics: [] };
      }),
    execute: () =>
      Effect.sync(() => {
        calls.push("execute");
        return { value: 1, logs: [], warnings: [] };
      }),
  });
