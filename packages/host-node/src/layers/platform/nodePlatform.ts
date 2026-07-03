import { Layer } from "effect";
import type { NodeCodeModeHostOptions } from "../../options.js";
import { NodeConfigDiscoveryContext, NodeConfigDiscoveryContextLive } from "./configDiscoveryContext.js";
import { NodeHostIdentity, NodeHostIdentityLive } from "./hostIdentity.js";
import { NodeHostSettings, NodeHostSettingsLive } from "./hostSettings.js";

export type NodeHostProcessPlatform = NodeConfigDiscoveryContext | NodeHostSettings;
export type NodeHostRuntimePlatform = NodeHostProcessPlatform | NodeHostIdentity;

/** Process-level Node platform context shared by the HTTP listener and all per-host runtimes. */
export const NodeHostPlatformLive = (
  options: NodeCodeModeHostOptions = {},
): Layer.Layer<NodeHostProcessPlatform> => {
  const discoveryLayer = NodeConfigDiscoveryContextLive({
    ...(options.argv === undefined ? {} : { argv: options.argv }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const settingsLayer = NodeHostSettingsLive({
    ...(options.publicOrigin === undefined
      ? {}
      : { publicOrigin: options.publicOrigin }),
    ...(options.auth === undefined ? {} : { auth: options.auth }),
  }).pipe(Layer.provide(discoveryLayer));

  return Layer.merge(discoveryLayer, settingsLayer);
};

export const NodeHostRuntimePlatformLive = (input: {
  readonly hostId: string | undefined;
  readonly processPlatformLayer: Layer.Layer<NodeHostProcessPlatform>;
}): Layer.Layer<NodeHostRuntimePlatform> =>
  Layer.merge(
    input.processPlatformLayer,
    NodeHostIdentityLive(input.hostId),
  );
