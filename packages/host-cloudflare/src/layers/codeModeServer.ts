/**
 * @file Cloudflare adapter from the host-neutral CodeMode service to the
 * schema-backed CodeModeServer RPC contract served by CodeModeObject.call(...).
 *
 * Worker routes should not switch over Code Mode operations. They parse and
 * forward requests to the Durable Object; this layer keeps operation dispatch
 * inside the configured Effect runtime next to the CodeMode service it calls.
 */
import {
  CodeMode,
  type CodeModeError,
} from "@ptools/code-mode";
import {
  CodeModeServer,
  CodeModeServerFailure,
  type CodeModeRequest,
  type CodeModeResponse,
  type CodeModeServerError,
} from "@ptools/code-mode-api";
import { Context, Effect, Layer } from "effect";

/**
 * Provides the CodeModeServer service by delegating every schema-backed request
 * to the matching method on the configured CodeMode service.
 */
export const CloudflareCodeModeServerLayer: Layer.Layer<
  CodeModeServer,
  never,
  CodeMode
> = Layer.effect(
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
  codeMode: Context.Tag.Service<typeof CodeMode>,
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
    message: `Cloudflare Code Mode request failed. ${cause.message}`,
    cause,
  });
