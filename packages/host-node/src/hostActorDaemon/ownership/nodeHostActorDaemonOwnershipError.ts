/**
 * @file Typed failures for cross-process daemon ownership and metadata.
 *
 * These failures belong to the outermost daemon scope. They describe ownership
 * contention, native lock acquisition, and generation-bound metadata I/O; they
 * do not represent RPC procedure or actor-runtime failures.
 */
import { Data } from "effect";

/** Another cooperating daemon currently owns the selected state namespace. */
export class NodeHostActorDaemonAlreadyOwned extends Data.TaggedError(
  "NodeHostActorDaemonAlreadyOwned",
)<{ readonly internalStateDirectory: string }> {}

/** File-open, native-addon, or kernel-lock failure during ownership acquisition. */
export class NodeHostActorDaemonOwnershipError extends Data.TaggedError(
  "NodeHostActorDaemonOwnershipError",
)<{
  readonly operation:
    | "load-native-lock"
    | "open-lock-file"
    | "acquire-lock"
    | "close-lock-file";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Atomic ready-metadata or credential-file publication failure. */
export class NodeHostActorDaemonReadyMetadataError extends Data.TaggedError(
  "NodeHostActorDaemonReadyMetadataError",
)<{
  readonly operation: "decode" | "write" | "flush" | "rename" | "remove";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Expected executable result when another daemon won startup contention. */
export const NODE_HOST_ACTOR_DAEMON_ALREADY_OWNED_EXIT_CODE = 75;
