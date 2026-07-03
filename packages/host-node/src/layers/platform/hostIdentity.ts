import { Context, Layer } from "effect";
import { DEFAULT_HOST_ID } from "../../options.js";

/** Host id for one Node runtime selected from the shared Host API request path. */
export class NodeHostIdentity extends Context.Tag(
  "@ptools/host-node/NodeHostIdentity",
)<
  NodeHostIdentity,
  {
    readonly hostId: string;
  }
>() {}

export const NodeHostIdentityLive = (
  hostId: string | undefined = DEFAULT_HOST_ID,
): Layer.Layer<NodeHostIdentity> =>
  Layer.succeed(NodeHostIdentity, NodeHostIdentity.of({ hostId }));
