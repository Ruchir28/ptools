/**
 * @file Wire contract for the daemon's private typed procedure surface.
 *
 * The daemon process and its trusted caller-side client share this `RpcGroup`.
 * Effect Schema owns application payload encoding while `@effect/rpc` owns
 * request IDs, tracing, and envelopes. No handler, listener, lease state, or
 * actor runtime lives in this file.
 */
import {
  HostOperationDispatchInput,
  HostOperationResponse,
} from "@ptools/host-api";
import { Rpc, RpcGroup, RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";

export const NODE_HOST_ACTOR_DAEMON_PROTOCOL_VERSION = "1";
export const NODE_HOST_ACTOR_DAEMON_RPC_PATH = "/rpc";
export const NODE_HOST_ACTOR_DAEMON_CREDENTIAL_HEADER = "authorization";
export const NODE_HOST_ACTOR_DAEMON_PROTOCOL_HEADER =
  "x-ptools-daemon-protocol-version";

/** Authenticated health identity used to validate ready metadata generation. */
export const NodeHostActorDaemonHealth = Schema.Struct({
  protocolVersion: Schema.String,
  ownerGeneration: Schema.String,
  pid: Schema.Number,
  startedAtEpochMs: Schema.Number,
});
export type NodeHostActorDaemonHealth = Schema.Schema.Type<
  typeof NodeHostActorDaemonHealth
>;

/** Public representation of one daemon-owned server lease. */
export const NodeDaemonServerLease = Schema.Struct({
  leaseId: Schema.String,
  expiresAtEpochMs: Schema.Number,
});
export type NodeDaemonServerLease = Schema.Schema.Type<
  typeof NodeDaemonServerLease
>;

export const NodeDaemonLeaseReleaseResult = Schema.Union(
  Schema.TaggedStruct("Released", {}),
  Schema.TaggedStruct("NotFound", {}),
);
export type NodeDaemonLeaseReleaseResult = Schema.Schema.Type<
  typeof NodeDaemonLeaseReleaseResult
>;

/** Missing or incorrect private daemon credential. */
export class NodeDaemonUnauthorized extends Schema.TaggedError<NodeDaemonUnauthorized>()(
  "NodeDaemonUnauthorized",
  { message: Schema.String },
) {}

/** Caller and live daemon use incompatible ptools protocol versions. */
export class NodeDaemonProtocolVersionMismatch extends Schema.TaggedError<NodeDaemonProtocolVersionMismatch>()(
  "NodeDaemonProtocolVersionMismatch",
  { expected: Schema.String, received: Schema.String },
) {}

/** Unknown, expired, or no-longer-admissible server lease. */
export class NodeDaemonLeaseRejected extends Schema.TaggedError<NodeDaemonLeaseRejected>()(
  "NodeDaemonLeaseRejected",
  {
    leaseId: Schema.String,
    reason: Schema.Literal("unknown", "expired", "shutting-down"),
    message: Schema.String,
  },
) {}

/** Safe serializable projection of an actor runtime lifecycle failure. */
export class NodeHostActorRuntimeRpcError extends Schema.TaggedError<NodeHostActorRuntimeRpcError>()(
  "NodeHostActorRuntimeRpcError",
  {
    hostId: Schema.String,
    phase: Schema.Literal("activate", "execute", "dispose"),
    message: Schema.String,
  },
) {}

/** Applied to every daemon procedure; implementation checks HTTP headers. */
export class NodeDaemonCredentialProtocolMiddleware extends RpcMiddleware.Tag<NodeDaemonCredentialProtocolMiddleware>()(
  "@ptools/host-node/hostActorDaemon/NodeDaemonCredentialProtocolMiddleware",
  {
    failure: Schema.Union(
      NodeDaemonUnauthorized,
      NodeDaemonProtocolVersionMismatch,
    ),
  },
) {}

/**
 * RPC adapter that admits one host operation under its server lease and keeps
 * that admission active until the downstream handler Effect finishes.
 */
export class NodeDaemonOperationAdmissionMiddleware extends RpcMiddleware.Tag<NodeDaemonOperationAdmissionMiddleware>()(
  "@ptools/host-node/hostActorDaemon/NodeDaemonOperationAdmissionMiddleware",
  { failure: NodeDaemonLeaseRejected, wrap: true },
) {}

/** Complete V1 private daemon procedure group. */
export class NodeHostActorDaemonRpcs extends RpcGroup.make(
  Rpc.make("Health", { success: NodeHostActorDaemonHealth }),
  Rpc.make("AcquireServerLease", {
    success: NodeDaemonServerLease,
    error: NodeDaemonLeaseRejected,
  }),
  Rpc.make("RenewServerLease", {
    payload: { leaseId: Schema.String },
    success: NodeDaemonServerLease,
    error: NodeDaemonLeaseRejected,
  }),
  Rpc.make("ReleaseServerLease", {
    payload: { leaseId: Schema.String },
    success: NodeDaemonLeaseReleaseResult,
  }),
  Rpc.make("HandleHostOperation", {
    payload: {
      leaseId: Schema.String,
      input: HostOperationDispatchInput,
    },
    success: HostOperationResponse,
    error: NodeHostActorRuntimeRpcError,
  }).middleware(NodeDaemonOperationAdmissionMiddleware),
).middleware(NodeDaemonCredentialProtocolMiddleware) {}
