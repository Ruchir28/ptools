import { CodeExecutor, ExecuteRequest } from "@ptools/executor";
import {
  McpRegistry,
  type DiscoveredMcpTool,
} from "@ptools/mcp-registry";
import { Context, Effect, Layer, Option } from "effect";
import {
  buildCodeModeRuntime,
  makeCodeModeSearchResult,
  makeCodeModeSearchProvidersResult,
  makeCodeModeToolSchemaResult,
  type CodeModeRuntime,
} from "./context.js";
import type { SchemaCompiler } from "./declarations.js";
import {
  CodeModeExecuteError,
  CodeModeInvariantError,
  type CodeModeError,
} from "./errors.js";
import type {
  CodeModeDiagnostic,
  CodeModeAuthStatusResult,
  CodeModeExecuteRequest,
  CodeModeRunResult,
  CodeModeSearchProvidersRequest,
  CodeModeSearchProvidersResult,
  CodeModeSearchRequest,
  CodeModeSearchResult,
  CodeModeToolSchemaRequest,
  CodeModeToolSchemaResult,
} from "@ptools/code-mode-api";

export interface MakeCodeModeLiveOptions {
  readonly schemaCompiler?: SchemaCompiler;
}

/**
 * Host-side Code Mode service.
 *
 * `search` returns schema-free MCP-backed API summaries. `toolSchema` returns
 * full schema/declaration details for selected tools. `execute` runs generated
 * JavaScript through the configured executor with provider functions backed by
 * the MCP registry.
 */
export class CodeMode extends Context.Tag("@ptools/CodeMode")<
  CodeMode,
  {
    readonly diagnostics: Effect.Effect<
      ReadonlyArray<CodeModeDiagnostic>,
      CodeModeError
    >;
    readonly authStatus: Effect.Effect<CodeModeAuthStatusResult>;
    readonly refresh: Effect.Effect<void, CodeModeError>;
    readonly searchProviders: (
      request?: CodeModeSearchProvidersRequest,
    ) => Effect.Effect<CodeModeSearchProvidersResult, CodeModeError>;
    readonly search: (
      request: CodeModeSearchRequest,
    ) => Effect.Effect<CodeModeSearchResult, CodeModeError>;
    readonly toolSchema: (
      request: CodeModeToolSchemaRequest,
    ) => Effect.Effect<CodeModeToolSchemaResult, CodeModeError>;
    readonly execute: (
      request: CodeModeExecuteRequest,
    ) => Effect.Effect<CodeModeRunResult, CodeModeError>;
  }
>() {}

/**
 * Builds the Code Mode Effect layer from an MCP registry and code executor.
 *
 * Inputs come from the environment:
 * - `McpRegistry` supplies discovered upstream MCP tools and dispatch.
 * - `CodeExecutor` runs generated sandbox code.
 *
 * Output is a `CodeMode` service whose providers are built from the current
 * registry snapshot and cached until the registry refreshes.
 */
export const makeCodeModeLive = (
  options: MakeCodeModeLiveOptions = {},
): Layer.Layer<CodeMode, CodeModeError, McpRegistry | CodeExecutor> =>
  Layer.effect(
    CodeMode,
    Effect.gen(function* () {
      const registry = yield* McpRegistry;
      const executor = yield* CodeExecutor;
      let cachedTools: ReadonlyArray<DiscoveredMcpTool> | undefined;
      let cachedDiagnostics: ReadonlyArray<CodeModeDiagnostic> | undefined;
      let cachedRuntime: CodeModeRuntime | undefined;
      const buildRuntime = Effect.gen(function* () {
        const tools = yield* registry.listTools;
        const diagnostics = yield* registry.diagnostics;

        if (
          cachedRuntime !== undefined &&
          cachedTools === tools &&
          cachedDiagnostics === diagnostics
        ) {
          return cachedRuntime;
        }

        const runtime = yield* buildCodeModeRuntime(tools, registry, {
          diagnostics,
          ...(options.schemaCompiler === undefined
            ? {}
            : { schemaCompiler: options.schemaCompiler }),
        });

        cachedTools = tools;
        cachedDiagnostics = diagnostics;
        cachedRuntime = runtime;

        return runtime;
      });

      const refresh = registry.refresh.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cachedTools = undefined;
            cachedDiagnostics = undefined;
            cachedRuntime = undefined;
          }),
        ),
        Effect.mapError(
          (cause) =>
            new CodeModeInvariantError({
              message: "Failed to refresh MCP registry",
              cause,
            }),
        ),
      );

      const diagnostics = buildRuntime.pipe(
        Effect.map((runtime) => runtime.diagnostics),
      );

      return {
        diagnostics,
        authStatus: registry.authStatus,
        refresh,
        searchProviders: (request?: CodeModeSearchProvidersRequest) =>
          buildRuntime.pipe(
            Effect.flatMap((runtime) =>
              request === undefined ||
              ((Option.isNone(request.query) ||
                request.query.value.trim() === "") &&
                Option.isNone(request.limit))
                ? Effect.succeed(runtime.fullProviderSearchResult)
                : Effect.try({
                    try: () =>
                      makeCodeModeSearchProvidersResult(
                        runtime.servers,
                        runtime.diagnostics,
                        request,
                      ),
                    catch: (cause) =>
                      cause instanceof CodeModeInvariantError
                        ? cause
                        : new CodeModeInvariantError({
                            message: "Failed to search Code Mode providers",
                            cause,
                          }),
                  }),
            ),
          ),
        search: (request: CodeModeSearchRequest) =>
          buildRuntime.pipe(
            Effect.flatMap((runtime) =>
              makeCodeModeSearchResult(
                runtime.servers,
                runtime.diagnostics,
                request,
              ),
            ),
          ),
        toolSchema: (request: CodeModeToolSchemaRequest) =>
          buildRuntime.pipe(
            Effect.flatMap((runtime) =>
              makeCodeModeToolSchemaResult(
                runtime.servers,
                runtime.declarationIndex,
                request,
                runtime.diagnostics,
              ),
            ),
          ),
        execute: (request: CodeModeExecuteRequest) =>
          buildRuntime.pipe(
            Effect.flatMap((runtime) =>
              // Adapter from the schema-backed Code Mode API DTO into the
              // executor-domain ExecuteRequest. `timeoutMs` is already
              // Option<number> from the schema, so no `undefined` branching.
              // Provider callbacks close over the MCP registry here; the
              // sandbox only ever receives pure SandboxProviderManifest data.
              executor
                .execute(new ExecuteRequest({
                  code: request.code,
                  globals: Option.none(),
                  providers: Option.some(runtime.providers),
                  timeoutMs: request.timeoutMs,
                }))
                .pipe(
                  Effect.map((result) => ({
                    value: result.value,
                    logs: result.logs,
                  })),
                  Effect.mapError(
                    (cause) => new CodeModeExecuteError({ cause }),
                  ),
                ),
            ),
          ),
      };
    }),
  );
