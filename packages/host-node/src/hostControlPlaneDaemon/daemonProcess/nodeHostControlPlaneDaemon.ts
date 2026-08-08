/**
 * @file Foreground process lifecycle for one named local Node deployment.
 *
 * The command process owns the deployment lock, actor-daemon connection/lease,
 * and fixed public listener until Ctrl-C or process-supervisor interruption.
 * There is no HTTP lifecycle protocol and ordinary clients have no influence on
 * this scope.
 */
import { Effect, Layer } from "effect";
import { DEFAULT_NODE_DEPLOYMENT_NAME } from "../../localDeployments/contracts/nodeDeploymentName.js";
import { resolveNodeLocalDeployment } from "../../localDeployments/nodeLocalDeploymentCatalog.js";
import { HostNodeError } from "../../options.js";
import { NodeHostControlPlaneHttpLive } from "../http/nodeHostControlPlaneHttp.js";
import { acquireNodeHostControlPlaneOwnership } from "../ownership/nodeHostControlPlaneOwnership.js";

/** Runs the selected deployment in this process until its Effect is interrupted. */
export const runNodeHostControlPlaneDaemon = (deploymentName: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const descriptor = yield* resolveNodeLocalDeployment(deploymentName, {
        createDefaultIfMissing:
          deploymentName === DEFAULT_NODE_DEPLOYMENT_NAME,
      });
      yield* acquireNodeHostControlPlaneOwnership(descriptor.stateDirectory);

      // Re-read under ownership so configure racing startup cannot make this
      // process bind infrastructure settings resolved before it won the lock.
      const current = yield* resolveNodeLocalDeployment(deploymentName);
      if (
        current.stateDirectory !== descriptor.stateDirectory ||
        current.controlPlanePort !== descriptor.controlPlanePort
      ) {
        return yield* new HostNodeError({
          message:
            "Deployment descriptor changed during control-plane startup.",
        });
      }

      yield* Layer.build(
        NodeHostControlPlaneHttpLive({ descriptor: current }),
      );
      return yield* Effect.never;
    }),
  );
