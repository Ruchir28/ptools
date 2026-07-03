import { Context, Layer } from "effect";
import type { NodeEnv } from "../../options.js";

/** Node process inputs used for config discovery and env-secret resolution. */
export class NodeConfigDiscoveryContext extends Context.Tag(
  "@ptools/host-node/NodeConfigDiscoveryContext",
)<
  NodeConfigDiscoveryContext,
  {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: NodeEnv;
  }
>() {}

export const NodeConfigDiscoveryContextLive = (options: {
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeEnv;
} = {}): Layer.Layer<NodeConfigDiscoveryContext> =>
  Layer.succeed(
    NodeConfigDiscoveryContext,
    NodeConfigDiscoveryContext.of({
      argv: options.argv ?? [],
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
    }),
  );
