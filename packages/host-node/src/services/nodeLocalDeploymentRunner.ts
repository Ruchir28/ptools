/**
 * @file Explicit foreground start and descriptor-based local client connection.
 *
 * `startNodeLocalDeployment` owns the server scope in the calling process.
 * `connectLocalNodeHost` is only a convenience that maps a deployment name to
 * its configured URL and creates the shared Host HTTP client. It performs no
 * process discovery, health preflight, startup, retention, or shutdown.
 */
import type { HostClientHandle } from "@ptools/host-api";
import { createHostHttpClient } from "@ptools/host-api/http";
import { Data, Effect } from "effect";
import { runNodeHostControlPlaneDaemon } from "../hostControlPlaneDaemon/daemonProcess/nodeHostControlPlaneDaemon.js";
import {
  DEFAULT_NODE_DEPLOYMENT_NAME,
  type NodeDeploymentName,
} from "../localDeployments/contracts/nodeDeploymentName.js";
import { nodeControlPlanePublicOrigin } from "../localDeployments/contracts/nodeLocalDeploymentDescriptor.js";
import { resolveNodeLocalDeployment } from "../localDeployments/nodeLocalDeploymentCatalog.js";
import { NODE_INTERNAL_ACCESS_TOKEN } from "../options.js";

export class NodeLocalDeploymentError extends Data.TaggedError(
  "NodeLocalDeploymentError",
)<{ readonly message: string; readonly cause?: unknown }> {}

/** Selects one cataloged deployment endpoint and one logical actor inside it. */
export interface ConnectLocalNodeHostOptions {
  readonly deploymentName?: NodeDeploymentName;
  readonly hostId: string;
}

/** Runs the selected deployment in the foreground until Effect interruption. */
export const startNodeLocalDeployment = (
  deploymentName: string,
): Effect.Effect<void, NodeLocalDeploymentError, never> =>
  runNodeHostControlPlaneDaemon(deploymentName).pipe(
    Effect.mapError(toRunnerError),
  );

/**
 * Resolves a named descriptor to its fixed URL and creates an ordinary client.
 * The first actual Host operation is responsible for surfacing connection or
 * protocol failure, exactly like `createHostHttpClient` with an explicit URL.
 */
export const connectLocalNodeHost = async (
  options: ConnectLocalNodeHostOptions,
): Promise<HostClientHandle> => {
  if (options.hostId.trim() === "")
    throw new NodeLocalDeploymentError({
      message: "Node hostId must not be empty.",
    });
  const deploymentName = options.deploymentName ?? DEFAULT_NODE_DEPLOYMENT_NAME;
  const descriptor = await Effect.runPromise(
    resolveNodeLocalDeployment(deploymentName).pipe(
      Effect.mapError(toRunnerError),
    ),
  );
  return createHostHttpClient({
    baseUrl: nodeControlPlanePublicOrigin(descriptor.controlPlanePort),
    hostId: options.hostId,
    accessToken: NODE_INTERNAL_ACCESS_TOKEN,
  });
};

const toRunnerError = (cause: unknown): NodeLocalDeploymentError =>
  cause instanceof NodeLocalDeploymentError
    ? cause
    : new NodeLocalDeploymentError({
        message:
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
            ? cause.message
            : String(cause),
        cause,
      });
