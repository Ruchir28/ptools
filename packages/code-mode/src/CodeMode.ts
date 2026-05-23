import { CodeExecutor } from "@ptools/executor";
import { McpRegistry } from "@ptools/mcp-registry";
import { Context, Effect, Layer } from "effect";
import {
  buildCodeModeRuntime,
  makeCodeModeSearchResult,
  makeCodeModeSearchProvidersResult,
  makeCodeModeToolSchemaResult,
} from "./context.js";
import type { SchemaCompiler } from "./declarations.js";
import {
  CodeModeExecuteError,
  CodeModeInvariantError,
  type CodeModeError,
} from "./errors.js";
import type {
  CodeModeDiagnostic,
  CodeModeExecuteRequest,
  CodeModeRunResult,
  CodeModeSearchProvidersRequest,
  CodeModeSearchProvidersResult,
  CodeModeSearchRequest,
  CodeModeSearchResult,
  CodeModeToolSchemaRequest,
  CodeModeToolSchemaResult,
} from "./types.js";

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
    readonly diagnostics: Effect.Effect<ReadonlyArray<CodeModeDiagnostic>>;
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
 * Output is a `CodeMode` service whose providers are built once at startup
 * from the registry's discovered tool surface.
 */
export const makeCodeModeLive = (
  options: MakeCodeModeLiveOptions = {},
): Layer.Layer<CodeMode, CodeModeError, McpRegistry | CodeExecutor> =>
  Layer.effect(
    CodeMode,
    Effect.gen(function* () {
      const registry = yield* McpRegistry;
      const executor = yield* CodeExecutor;
      const tools = yield* registry.listTools;
      const diagnostics = yield* registry.diagnostics;
      const runtime = yield* buildCodeModeRuntime(tools, registry, {
        diagnostics,
        ...(options.schemaCompiler === undefined
          ? {}
          : { schemaCompiler: options.schemaCompiler }),
      });

      return {
        diagnostics: Effect.succeed(runtime.diagnostics),
        searchProviders: (request?: CodeModeSearchProvidersRequest) =>
          request === undefined ||
          ((request.query === undefined || request.query.trim() === "") &&
            request.limit === undefined)
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
        search: (request: CodeModeSearchRequest) =>
          makeCodeModeSearchResult(
            runtime.servers,
            runtime.diagnostics,
            request,
          ),
        toolSchema: (request: CodeModeToolSchemaRequest) =>
          makeCodeModeToolSchemaResult(
            runtime.servers,
            runtime.declarationIndex,
            request,
            runtime.diagnostics,
          ),
        execute: (request: CodeModeExecuteRequest) =>
          executor
            .execute({
              code: request.code,
              providers: runtime.providers,
              ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
            })
            .pipe(
              Effect.map((result) => ({
                value: result.value,
                logs: result.logs,
              })),
              Effect.mapError((cause) => new CodeModeExecuteError({ cause })),
            ),
      };
    }),
  );
