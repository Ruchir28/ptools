#!/usr/bin/env node
/** Package-owned foreground executable for the Node Host Control-Plane. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect } from "effect";
import { pathToFileURL } from "node:url";
import { runNodeHostControlPlaneDaemon } from "./nodeHostControlPlaneDaemon.js";

class NodeHostControlPlaneArgumentError extends Data.TaggedError(
  "NodeHostControlPlaneArgumentError",
)<{ readonly message: string }> {}

/** Parses one deployment name and runs that server in this process. */
export const nodeHostControlPlaneDaemonMain = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
) =>
  parseDeploymentName(argv).pipe(
    Effect.flatMap(runNodeHostControlPlaneDaemon),
    Effect.provide(NodeServices.layer),
  );

const parseDeploymentName = (argv: ReadonlyArray<string>) =>
  argv.length === 2 && argv[0] === "--deployment-name" && argv[1] !== undefined
    ? Effect.succeed(argv[1])
    : Effect.fail(
        new NodeHostControlPlaneArgumentError({
          message: "Expected --deployment-name <name>.",
        }),
      );

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  NodeRuntime.runMain(nodeHostControlPlaneDaemonMain());
}
