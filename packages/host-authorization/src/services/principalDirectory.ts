import { Context, Effect, Option } from "effect";
import type {
  PrincipalDirectoryError,
  PrincipalProfile,
} from "../contracts/principalProfile.js";
import type { PrincipalId } from "../contracts/principal.js";

/**
 * Optional provider-owned presentation lookup for durable Principals.
 * `Option.none` is ordinary profile absence; provider failure remains typed and
 * cannot be interpreted as an authorization result.
 */
export class PrincipalDirectory extends Context.Service<
  PrincipalDirectory,
  {
    readonly findProfile: (
      principalId: PrincipalId,
    ) => Effect.Effect<
      Option.Option<PrincipalProfile>,
      PrincipalDirectoryError
    >;
  }
>()("@ptools/host-authorization/PrincipalDirectory") {}
