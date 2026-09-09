import type { HostCaller, HostPermission } from "../contracts/index.js";
import { Context, type HashSet } from "effect";

/**
 * Authority resolved once for the current Host request.
 *
 * Admission constructs this value from either current Principal roles or a
 * verified Host token's frozen grants. `caller` retains safe identity facts for
 * trusted logging/audit, while ordinary policies make decisions only from the
 * effective-permission set.
 */
export class HostAuthorizationContext extends Context.Service<
  HostAuthorizationContext,
  {
    readonly hostId: string;
    readonly caller: HostCaller;
    readonly effectivePermissions: HashSet.HashSet<HostPermission>;
  }
>()("@ptools/host-authorization/HostAuthorizationContext") {}
