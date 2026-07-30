/**
 * @file Host-neutral adapter from the CodeMode service to the schema-backed
 * CodeModeServer contract used by platform transports.
 *
 * Node, Cloudflare, and future hosts can all share this layer: platform code
 * owns request parsing / RPC transport, while this adapter owns Code Mode
 * operation dispatch once a validated CodeModeRequest is inside Effect.
 */
import {
  CodeModeServerFailure,
  type CodeModeRequest,
  type CodeModeResponse,
  type CodeModeServerError,
} from "@ptools/code-mode-api";
import { CodeModeServer } from "@ptools/code-mode-api/effect";
import { Context, Effect, Layer } from "effect";
import { CodeMode } from "./CodeMode.js";
import type { CodeModeError } from "./errors.js";

/**
 * Provides CodeModeServer by delegating each schema-backed request to the
 * matching method on the configured CodeMode service.
 */
export const CodeModeServerLayer: Layer.Layer<CodeModeServer, never, CodeMode> =
  Layer.effect(
    CodeModeServer,
    Effect.gen(function* () {
      const codeMode = yield* CodeMode;

      return {
        handle: (request: CodeModeRequest) =>
          handleCodeModeRequest(codeMode, request),
      };
    }),
  );

const handleCodeModeRequest = (
  codeMode: Context.Service.Shape<typeof CodeMode>,
  request: CodeModeRequest,
): Effect.Effect<CodeModeResponse, CodeModeServerError> => {
  switch (request.operation) {
    case "auth_status":
      return codeMode.authStatus.pipe(
        Effect.map((output) => ({ operation: "auth_status" as const, output })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "refresh":
      return codeMode.refresh.pipe(
        Effect.as({
          operation: "refresh" as const,
          output: { refreshed: true as const },
        }),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "search_providers":
      return codeMode.searchProviders(request.input).pipe(
        Effect.map((output) => ({
          operation: "search_providers" as const,
          output,
        })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "search":
      return codeMode.search(request.input).pipe(
        Effect.map((output) => ({ operation: "search" as const, output })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "get_tool_schema":
      return codeMode.toolSchema(request.input).pipe(
        Effect.map((output) => ({
          operation: "get_tool_schema" as const,
          output,
        })),
        Effect.mapError(toCodeModeServerFailure),
      );
    case "execute":
      return codeMode.execute(request.input).pipe(
        Effect.map((output) => ({ operation: "execute" as const, output })),
        Effect.mapError(toCodeModeServerFailure),
      );
  }
};

const toCodeModeServerFailure = (cause: CodeModeError): CodeModeServerFailure =>
  new CodeModeServerFailure({
    message: "Code Mode request failed.",
    cause,
  });
