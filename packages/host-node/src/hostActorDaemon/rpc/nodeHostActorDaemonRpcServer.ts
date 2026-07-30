/**
 * @file HTTP carrier and listener lifecycle for the private daemon RPC surface.
 *
 * Created once after process ownership, leases, and actor management exist. It
 * binds one ephemeral `127.0.0.1` port, mounts the typed `effect/unstable/rpc` group at
 * `/rpc`, and returns only the origin needed for ready metadata.
 *
 * It does not publish metadata or own procedure interpretation.
 */
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Context, Effect, Layer, Scope } from "effect";
import { createServer } from "node:http";
import {
  NODE_HOST_ACTOR_DAEMON_RPC_PATH,
  NodeHostActorDaemonRpcs,
} from "./nodeHostActorDaemonRpcContracts.js";
import type { NodeHostActorDaemonOwnership } from "../ownership/nodeHostActorDaemonOwnership.js";
import { NodeHostActorDaemonRpcServerError } from "./nodeHostActorDaemonRpcServerError.js";
import {
  NodeDaemonCredentialProtocolMiddlewareLive,
  NodeDaemonOperationAdmissionMiddlewareLive,
} from "./nodeHostActorDaemonRpcMiddleware.js";
import { NodeHostActorDaemonRpcHandlersLive } from "./nodeHostActorDaemonRpcHandlers.js";
import { NodeHostRuntimeManager } from "../actorRuntime/services/nodeHostRuntimeManager.js";
import { NodeHostActorDaemonLeaseManager } from "../leases/services/nodeHostActorDaemonLeaseManager.js";

export interface NodeHostActorDaemonRpcServer {
  readonly origin: string;
}

/**
 * Bind an ephemeral loopback port and keep the complete Effect HTTP/RPC layer
 * alive in the caller's supplied server scope. Returning means the listener is
 * bound and its origin is safe for ownership to publish as ready metadata.
 */
export const startNodeHostActorDaemonRpcServer = (
  ownership: NodeHostActorDaemonOwnership,
  credential: string,
): Effect.Effect<
  NodeHostActorDaemonRpcServer,
  NodeHostActorDaemonRpcServerError,
  Scope.Scope | NodeHostActorDaemonLeaseManager | NodeHostRuntimeManager
> =>
  Effect.gen(function* () {
    const rpcHandlers = NodeHostActorDaemonRpcHandlersLive(ownership);
    const rpc = RpcServer.layer(NodeHostActorDaemonRpcs).pipe(
      Layer.provide([
        rpcHandlers,
        NodeDaemonCredentialProtocolMiddlewareLive(credential),
        NodeDaemonOperationAdmissionMiddlewareLive,
      ]),
    );

    const protocol = RpcServer.layerProtocolHttp({
      path: NODE_HOST_ACTOR_DAEMON_RPC_PATH,
    }).pipe(Layer.provide(HttpRouter.layer));
    const rpcApp = rpc.pipe(Layer.provideMerge(protocol));
    const serverLayer = HttpRouter.serve(rpcApp, {
      disableListenLog: true,
    }).pipe(
      Layer.provide(RpcSerialization.layerJson),
      Layer.provideMerge(
        NodeHttpServer.layer(() => createServer(), {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
    );

    const context = yield* Layer.build(serverLayer).pipe(
      Effect.mapError(
        (cause) =>
          new NodeHostActorDaemonRpcServerError({
            message: "Unable to bind the private Node daemon RPC listener.",
            cause,
          }),
      ),
    );
    const server = Context.get(context, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress") {
      return yield* new NodeHostActorDaemonRpcServerError({
        message: "The private Node daemon listener did not bind a TCP address.",
      });
    }
    if (server.address.hostname !== "127.0.0.1") {
      return yield* new NodeHostActorDaemonRpcServerError({
        message: "The private Node daemon listener was not bound to loopback.",
      });
    }
    return {
      origin: `http://127.0.0.1:${server.address.port}`,
    };
  });
