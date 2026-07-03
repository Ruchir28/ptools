import { HttpApi, HttpApiBuilder } from "@effect/platform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Layer } from "effect";
import { createServer } from "node:http";
import type { ListenOptions } from "node:net";

/**
 * Low-level Node platform server layer for an already-configured Host HttpApi.
 *
 * This is the only place in host-node that turns an Effect HttpApi layer into a
 * real Node listener:
 *
 * ```txt
 * configured HostHttpApi layer
 *   -> HttpApiBuilder.serve()
 *   -> @effect/platform-node NodeHttpServer.layer(...)
 *   -> node:http createServer().listen(host, port)
 * ```
 *
 * It owns only server lifecycle. It does not create a Host HTTP client, does not
 * discover a random port, and does not publish server metadata. The caller must
 * pass the final public origin up front; that same origin is used elsewhere to
 * build client base URLs and OAuth callback URLs.
 */
export const NodeLocalHostHttpServerLive = (input: {
  readonly apiLayer: Layer.Layer<HttpApi.Api, unknown, never>;
  readonly publicOrigin: string;
}): Layer.Layer<never, unknown, never> =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(input.apiLayer),
    Layer.provideMerge(NodeHttpServer.layerContext),
    Layer.provideMerge(
      NodeHttpServer.layer(
        () => createServer(),
        resolveListenOptions(input.publicOrigin),
      ),
    ),
  );

const resolveListenOptions = (publicOrigin: string): ListenOptions => {
  const url = new URL(publicOrigin);
  if (url.protocol !== "http:") {
    throw new Error("Node local Host HTTP server requires an http:// publicOrigin.");
  }

  if (url.port === "") {
    throw new Error("Node local Host HTTP publicOrigin must include an explicit port.");
  }

  return {
    host: url.hostname || "127.0.0.1",
    port: Number(url.port),
  };
};
