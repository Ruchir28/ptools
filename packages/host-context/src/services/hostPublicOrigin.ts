import { Context, Layer } from "effect";

/**
 * Public origin used while building/running a configured host context.
 *
 * This service is created from `HostRuntimeBinding.origin` by the shared
 * configured-context runner. Platforms should not install it into a stable host
 * runtime because origin can vary by request, proxy, or deployment route.
 */
export class HostPublicOrigin extends Context.Tag(
  "@ptools/host-context/HostPublicOrigin",
)<
  HostPublicOrigin,
  {
    readonly origin: string;
  }
>() {}

/** Provide the request/runtime origin inside one configured host context build. */
export const HostPublicOriginLayer = (
  origin: string,
): Layer.Layer<HostPublicOrigin> => Layer.succeed(HostPublicOrigin, { origin });
