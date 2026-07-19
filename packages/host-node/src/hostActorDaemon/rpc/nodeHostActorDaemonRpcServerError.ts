/**
 * @file Typed failure for acquiring the private loopback RPC listener.
 *
 * This error belongs to daemon-wide HTTP carrier startup. Procedure failures
 * remain schema-encoded RPC errors and actor failures remain owned by the
 * selected actor runtime.
 */
import { Data } from "effect";

/** Failure while binding or validating the private loopback RPC listener. */
export class NodeHostActorDaemonRpcServerError extends Data.TaggedError(
  "NodeHostActorDaemonRpcServerError",
)<{ readonly message: string; readonly cause?: unknown }> {}
