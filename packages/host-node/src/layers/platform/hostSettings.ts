import { Context, Effect, Layer } from "effect";
import {
  DEFAULT_AUTH_SERVICE_NAME,
  DEFAULT_NODE_PUBLIC_ORIGIN,
  type NodeAuthOptions,
} from "../../options.js";
import { NodeConfigDiscoveryContext } from "./configDiscoveryContext.js";

/** Process-level Node Host API settings shared by all request-selected host runtimes. */
export class NodeHostSettings extends Context.Tag(
  "@ptools/host-node/NodeHostSettings",
)<
  NodeHostSettings,
  {
    readonly publicOrigin: string;
    readonly auth: {
      readonly serviceName: string;
      readonly autoOpen: boolean | undefined;
    };
  }
>() {}

export const NodeHostSettingsLive = (options: {
  readonly publicOrigin?: string | undefined;
  readonly auth?: NodeAuthOptions | undefined;
} = {}): Layer.Layer<NodeHostSettings, never, NodeConfigDiscoveryContext> =>
  Layer.effect(
    NodeHostSettings,
    Effect.gen(function* () {
      const discovery = yield* NodeConfigDiscoveryContext;

      return NodeHostSettings.of({
        publicOrigin: options.publicOrigin ?? DEFAULT_NODE_PUBLIC_ORIGIN,
        auth: {
          serviceName: options.auth?.serviceName ?? DEFAULT_AUTH_SERVICE_NAME,
          autoOpen: options.auth?.autoOpen ?? resolveAutoOpen(discovery.env),
        },
      });
    }),
  );

const resolveAutoOpen = (
  env: Readonly<Record<string, string | undefined>>,
): boolean | undefined => {
  if (env.PTOOLS_AUTH_AUTO_OPEN === "0" || env.PTOOLS_AUTH_AUTO_OPEN === "false") {
    return false;
  }

  return process.stderr.isTTY === true ? true : undefined;
};
