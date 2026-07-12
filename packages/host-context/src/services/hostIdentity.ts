import { Context, Layer } from "effect";

/**
 * Stable identity for one host instance.
 *
 * Platform shells provide this once for the host lifetime. It is intentionally
 * separate from request/public-origin facts because a host ID is stable while
 * the public origin may differ by route, proxy, or local development URL.
 */
export class HostIdentity extends Context.Tag(
  "@ptools/host-context/HostIdentity",
)<
  HostIdentity,
  {
    readonly hostId: string;
  }
>() {}

/** Provide one stable host identity to platform and shared host layers. */
export const HostIdentityLayer = (hostId: string): Layer.Layer<HostIdentity> =>
  Layer.succeed(HostIdentity, { hostId });
