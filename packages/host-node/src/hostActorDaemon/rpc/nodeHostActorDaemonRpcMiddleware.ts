/**
 * @file Security and admission middleware for private daemon procedures.
 *
 * Group middleware authenticates the daemon credential and ptools protocol
 * version from HTTP headers. Operation middleware asks the lease manager to
 * admit and track only `HandleHostOperation`. Middleware enforces these rules
 * but does not own credentials, leases, handlers, or HTTP lifecycle.
 */
import { timingSafeEqual } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER,
  NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
  NodeDaemonCredentialProtocolMiddleware,
  NodeDaemonLeaseRejected,
  NodeDaemonOperationAdmissionMiddleware,
  NodeDaemonProtocolVersionMismatch,
  NodeDaemonUnauthorized,
} from "./nodeHostActorDaemonRpcContracts.js";
import { NodeHostActorDaemonLeaseManager } from "../leases/services/nodeHostActorDaemonLeaseManager.js";

/**
 * Build group middleware that verifies the private bearer credential and
 * ptools protocol version before any procedure handler runs.
 */
export const NodeDaemonCredentialProtocolMiddlewareLive = (
  credential: string,
): Layer.Layer<NodeDaemonCredentialProtocolMiddleware> =>
  Layer.succeed(
    NodeDaemonCredentialProtocolMiddleware,
    NodeDaemonCredentialProtocolMiddleware.of(({ headers }) => {
      const authorization = headers[NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER];
      const receivedVersion =
        headers[NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER] ?? "";
      if (!secureEqual(authorization ?? "", `Bearer ${credential}`)) {
        return Effect.fail(
          new NodeDaemonUnauthorized({
            message:
              "The private Node daemon credential is missing or invalid.",
          }),
        );
      }
      if (receivedVersion !== NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION) {
        return Effect.fail(
          new NodeDaemonProtocolVersionMismatch({
            expected: NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION,
            received: receivedVersion,
          }),
        );
      }
      return Effect.void;
    }),
  );

/**
 * Connect the host-operation RPC procedure to daemon-wide lease admission.
 *
 * With `wrap: true`, `@effect/rpc` supplies `next`: a lazy Effect representing
 * the remainder of this same request, including the registered handler,
 * runtime-manager selection, and actor dispatch. The middleware extracts the
 * request's lease ID and pipes `next` through the lease manager's
 * `withOperationAdmission` combinator.
 *
 * The lease manager owns the complete acquire/use/release bracket. This RPC
 * adapter never receives a raw admission permit or Scope, so it cannot forget
 * cleanup, release admission before actor work finishes, or retain admission
 * for the lifetime of the HTTP server.
 */
export const NodeDaemonOperationAdmissionMiddlewareLive: Layer.Layer<
  NodeDaemonOperationAdmissionMiddleware,
  never,
  NodeHostActorDaemonLeaseManager
> = Layer.effect(
  NodeDaemonOperationAdmissionMiddleware,
  Effect.gen(function* () {
    const leases = yield* NodeHostActorDaemonLeaseManager;
    return NodeDaemonOperationAdmissionMiddleware.of(({ payload, next }) => {
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("leaseId" in payload) ||
        typeof payload.leaseId !== "string"
      ) {
        return Effect.fail(
          new NodeDaemonLeaseRejected({
            leaseId: "",
            reason: "unknown",
            message: "The host-operation RPC did not contain a lease ID.",
          }),
        );
      }
      // `pipe` constructs a larger lazy Effect; it does not start `next` here.
      // When @effect/rpc runs the returned Effect, admission is acquired first,
      // remains held throughout downstream actor execution, and is released on
      // every exit from that downstream Effect.
      return next.pipe(leases.withOperationAdmission(payload.leaseId));
    });
  }),
);

const secureEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};
