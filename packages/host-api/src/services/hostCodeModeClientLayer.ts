/**
 * Adapter from HostTransport to CodeModeClient.
 *
 * This file owns the shared unwrap logic for `host.codeMode`, so platform
 * packages do not each reinterpret host-api protocol failures and code_mode
 * operation failures differently.
 */
import {
  CodeModeRemoteError,
  CodeModeTransportError,
  type CodeModeClientError,
  type CodeModeRequest,
  type CodeModeResponse,
} from "@ptools/code-mode-api";
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import { Context, Effect, Layer } from "effect";
import { isHostOperationProtocolFailureResponse } from "../hostOperationResponseHelpers.js";
import type { HostOperationResponse } from "../contracts/hostOperationEnvelope.js";
import type { HostCodeModeResponse } from "../contracts/hostCodeMode.js";
import { HostTransport, type HostTransportError } from "./hostTransport.js";

/** Create a focused CodeModeClient from a host-api transport. */
export const makeCodeModeClientFromHostTransport = (
  transport: Context.Tag.Service<typeof HostTransport>,
): Context.Tag.Service<typeof CodeModeClient> => ({
  call: (request: CodeModeRequest) =>
    transport
      .call({ operation: "code_mode", input: request })
      .pipe(
        Effect.mapError(toCodeModeTransportError),
        Effect.flatMap(unwrapCodeModeResponse),
      ),
});

/** Layer that exposes CodeModeClient by wrapping HostTransport. */
export const HostTransportCodeModeClientLayer: Layer.Layer<
  CodeModeClient,
  never,
  HostTransport
> = Layer.effect(
  CodeModeClient,
  Effect.gen(function* () {
    const transport = yield* HostTransport;

    return makeCodeModeClientFromHostTransport(transport);
  }),
);

const unwrapCodeModeResponse = (
  response: HostOperationResponse,
): Effect.Effect<CodeModeResponse, CodeModeClientError> => {
  if (isHostOperationProtocolFailureResponse(response)) {
    return Effect.fail(
      new CodeModeRemoteError({
        message: response.error.message,
        cause: response,
      }),
    );
  }

  if (response.operation !== "code_mode") {
    return Effect.fail(
      new CodeModeRemoteError({
        message: `Host returned ${response.operation} for code_mode request.`,
        cause: response,
      }),
    );
  }

  return unwrapDispatchedCodeModeResponse(response);
};

const unwrapDispatchedCodeModeResponse = (
  response: HostCodeModeResponse,
): Effect.Effect<CodeModeResponse, CodeModeClientError> =>
  response.result.ok
    ? Effect.succeed(response.result.response)
    : Effect.fail(
        new CodeModeRemoteError({
          message: response.result.error.message,
          cause: response.result.error,
        }),
      );

const toCodeModeTransportError = (
  cause: HostTransportError,
): CodeModeClientError =>
  new CodeModeTransportError({
    message: "Host transport failed while calling Code Mode.",
    cause,
  });
