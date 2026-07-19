#!/usr/bin/env node
/**
 * @file Executable boundary for one detached host-actor daemon process.
 *
 * Caller-side startup code spawns this file as a new Node process and supplies
 * machine-specific startup settings through command-line arguments. This file
 * parses those arguments, installs Node platform services, maps expected
 * ownership contention to exit code 75, and starts the daemon lifecycle.
 * After startup, clients communicate with the daemon through authenticated
 * loopback RPC rather than command-line arguments.
 *
 * This entrypoint does not read user-authored ptools configuration or depend on
 * the caller's current working directory.
 */
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Data, Effect } from "effect";
import { pathToFileURL } from "node:url";
import { runNodeHostActorDaemon } from "./nodeHostActorDaemon.js";
import {
  NODE_HOST_ACTOR_DAEMON_ALREADY_OWNED_EXIT_CODE,
  NodeHostActorDaemonAlreadyOwned,
} from "../ownership/nodeHostActorDaemonOwnershipError.js";
import { resolveNodeHostActorRuntimeOptions } from "./nodeHostActorStateNamespace.js";

class NodeHostActorDaemonArgumentError extends Data.TaggedError(
  "NodeHostActorDaemonArgumentError",
)<{ readonly message: string }> {}

/**
 * Parse package-owned daemon arguments, resolve final physical settings, and
 * run until lease-driven shutdown or process interruption.
 */
export const nodeHostActorDaemonMain = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
) =>
  parseArguments(argv).pipe(
    Effect.flatMap((overrides) =>
      resolveNodeHostActorRuntimeOptions(overrides),
    ),
    Effect.flatMap(runNodeHostActorDaemon),
    Effect.catchTag("NodeHostActorDaemonAlreadyOwned", () =>
      Effect.sync(() => {
        process.exitCode = NODE_HOST_ACTOR_DAEMON_ALREADY_OWNED_EXIT_CODE;
      }),
    ),
    Effect.provide(NodeContext.layer),
  );

const parseArguments = (
  argv: ReadonlyArray<string>,
): Effect.Effect<
  {
    readonly internalStateDirectory?: string;
    readonly keyringServiceName?: string;
    readonly denoExecutable?: string;
  },
  NodeHostActorDaemonArgumentError
> =>
  Effect.try({
    try: () => {
      const values: {
        internalStateDirectory?: string;
        keyringServiceName?: string;
        denoExecutable?: string;
      } = {};
      for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`Missing value for daemon argument ${flag}.`);
        }
        if (flag === "--internal-state-directory") {
          values.internalStateDirectory = value;
        } else if (flag === "--keyring-service-name") {
          values.keyringServiceName = value;
        } else if (flag === "--deno-executable") {
          values.denoExecutable = value;
        } else {
          throw new Error(`Unknown daemon argument ${flag}.`);
        }
        index += 1;
      }
      return values;
    },
    catch: (cause) =>
      new NodeHostActorDaemonArgumentError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  NodeRuntime.runMain(nodeHostActorDaemonMain());
}

// Keep the contention type reachable in emitted declarations for callers that
// interpret the dedicated exit code without exposing daemon internals at root.
export type NodeHostActorDaemonContention = NodeHostActorDaemonAlreadyOwned;
