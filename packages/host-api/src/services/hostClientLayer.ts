/**
 * Effect-native host client service and layer.
 *
 * This file owns the shared host client built from HostTransport. Platform
 * packages provide the transport layer; this layer provides host convenience
 * operations and the focused `host.codeMode` capability.
 */
import { CodeModeClient } from "@ptools/code-mode-api/effect";
import { Context, Data, Effect, Layer } from "effect";
import type {
  HostApiRequest,
  HostApiResponse,
} from "../contracts/hostApiEnvelope.js";
import { HostTransport, type HostTransportError } from "./hostTransport.js";
import {
  HostTransportCodeModeClientLayer,
  makeCodeModeClientFromHostTransport,
} from "./hostCodeModeClientLayer.js";

/** Error raised by shared host client convenience methods. */
export class HostClientError extends Data.TaggedError("HostClientError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Effect-native host client service built from a HostTransport. */
export class HostClient extends Context.Tag("@ptools/HostClient")<
  HostClient,
  {
    /** Low-level escape hatch for any host-api operation. */
    readonly call: (
      request: HostApiRequest,
    ) => Effect.Effect<HostApiResponse, HostClientError>;

    /** Focused Code Mode capability derived from the same HostTransport. */
    readonly codeMode: Context.Tag.Service<typeof CodeModeClient>;
  }
>() {}

/** Shared layer that builds HostClient and CodeModeClient from HostTransport. */
export const HostClientLayer: Layer.Layer<
  HostClient | CodeModeClient,
  never,
  HostTransport
> = Layer.merge(
  Layer.effect(
    HostClient,
    Effect.gen(function* () {
      const transport = yield* HostTransport;
      const codeMode = makeCodeModeClientFromHostTransport(transport);

      return {
        call: (request: HostApiRequest) =>
          transport.call(request).pipe(Effect.mapError(toHostClientError)),
        codeMode,
      };
    }),
  ),
  HostTransportCodeModeClientLayer,
);

const toHostClientError = (cause: HostTransportError): HostClientError =>
  new HostClientError({
    message: "Host transport failed while calling host-api.",
    cause,
  });
