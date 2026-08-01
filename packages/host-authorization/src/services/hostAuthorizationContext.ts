import type {
  HostCallerPrincipal,
  HostPermission,
} from "../contracts/index.js";
import { Context, type HashSet } from "effect";

/**
 * Authority resolved once for the current host request.
 *
 * Ingress middleware constructs this value after authentication and persistence
 * lookup. Policies consume it without repeating database or RPC operations.
 */
export class HostAuthorizationContext extends Context.Service<
  HostAuthorizationContext,
  {
    readonly hostId: string;
    readonly principal: HostCallerPrincipal;
    readonly effectivePermissions: HashSet.HashSet<HostPermission>;
  }
>()("@ptools/host-authorization/HostAuthorizationContext") {}
