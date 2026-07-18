/**
 * Typed daemon-internal failure at the host-actor runtime boundary.
 *
 * The private RPC layer may later encode/map this failure, but expected
 * configure, auth, and Code Mode failures remain `HostOperationResponse`
 * values and never become this error.
 */
import { Data } from "effect";

/** Closed lifecycle phases reported by `NodeHostActorRuntimeError`. */
export const NodeHostActorRuntimePhase = {
  Activate: "activate",
  Execute: "execute",
  Dispose: "dispose",
} as const;

export type NodeHostActorRuntimePhase =
  (typeof NodeHostActorRuntimePhase)[keyof typeof NodeHostActorRuntimePhase];

/** Activation, execution, or disposal failure for one selected actor. */
export class NodeHostActorRuntimeError extends Data.TaggedError(
  "NodeHostActorRuntimeError",
)<{
  readonly hostId: string;
  readonly phase: NodeHostActorRuntimePhase;
  readonly message: string;
  readonly cause?: unknown;
}> {}
