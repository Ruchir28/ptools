/**
 * Cloudflare HTTP adapter for host-api messages.
 *
 * This file owns the carrier seam between Worker `Request` values and the
 * transport-agnostic host-api object protocol. It parses HTTP JSON bodies into
 * candidate objects, validates them with `@ptools/host-api`, and dispatches
 * already-decoded requests through the Cloudflare HostServer.
 */
import {
  makeHostApiProtocolFailureResponse,
  parseHostApiRequest,
  type HostApiProtocolFailureResponse,
  type HostApiRequest,
  type HostApiResponse,
} from "@ptools/host-api";
import { Effect } from "effect";
import { makeCloudflareHostServer } from "./hostServer.js";
import type { CodeModeObjectNamespace } from "./codeModeObjectRpc.js";

/** Request-scoped Cloudflare values needed to dispatch host-api operations. */
export interface CloudflareHostApiDispatchInput {
  readonly namespace: CodeModeObjectNamespace;
  readonly hostId: string;
  readonly origin: string;
  readonly request: HostApiRequest;
}

/** Parse a Worker JSON body as a host-api request or protocol failure. */
export const readHostApiJsonRequest = (
  request: Request,
): Effect.Effect<HostApiRequest | HostApiProtocolFailureResponse> =>
  Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () =>
      makeHostApiProtocolFailureResponse({
        code: "invalid_host_api_request",
        message: "Invalid JSON body",
      }),
  }).pipe(
    Effect.flatMap((value) =>
      parseHostApiRequest(value).pipe(
        Effect.mapError((cause) =>
          makeHostApiProtocolFailureResponse({
            code: "invalid_host_api_request",
            message: cause.message,
          }),
        ),
      ),
    ),
    Effect.catchAll((failure) => Effect.succeed(failure)),
  );

/**
 * Dispatch one decoded HostApiRequest through a request-scoped HostServer.
 *
 * The HostServer value created here is intentionally just a tiny closure over
 * the current Worker route context. It does not build or cache the expensive
 * Code Mode runtime; that lifecycle belongs to `CodeModeObject`. If the
 * Worker-side dispatcher later acquires resources or builds expensive state,
 * revisit this per-request construction instead of hiding that work here.
 */
export const dispatchCloudflareHostApiRequest = (
  input: CloudflareHostApiDispatchInput,
): Effect.Effect<HostApiResponse> => {
  const server = makeCloudflareHostServer({
    namespace: input.namespace,
    hostId: input.hostId,
    origin: input.origin,
  });

  return server.handle(input.request).pipe(
    Effect.catchAll((cause) =>
      Effect.succeed(
        makeHostApiProtocolFailureResponse({
          code: "host_unavailable",
          message: cause.message,
        }),
      ),
    ),
  );
};
