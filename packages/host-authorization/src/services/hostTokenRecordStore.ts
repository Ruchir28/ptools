/**
 * Minimum platform persistence port for hash-only host-token records.
 *
 * Implementations enforce unique token IDs and hashes, strictly decode stored
 * values, and make revocation an atomic idempotent compare/set operation.
 */
import { Context, Effect, Option } from "effect";
import type { RegisteredHostNotFound } from "../contracts/hostAccessErrors.js";
import type {
  HostTokenHash,
  HostTokenRecord,
} from "../contracts/hostToken.js";
import type {
  HostTokenInvariantViolation,
  HostTokenNotFound,
  HostTokenRecordAlreadyExists,
  HostTokenStoreError,
} from "../contracts/hostTokenErrors.js";
import type { RevokeHostTokenRecordInput } from "../contracts/hostTokenOperations/revokeHostToken.js";

/**
 * Platform-owned persistence capability consumed by the shared lifecycle.
 * `create` receives a validated hash-only record, `findByHash` supports one
 * fixed-length authentication lookup, and `revoke` is the host-scoped atomic
 * mutation seam. No method accepts, returns, lists, or reconstructs plaintext.
 * SQLite/D1 implementations remain outside this package and expose only these
 * operations after strictly decoding their private physical representation.
 */
export class HostTokenRecordStore extends Context.Service<
  HostTokenRecordStore,
  {
    readonly create: (
      record: HostTokenRecord,
    ) => Effect.Effect<
      HostTokenRecord,
      | RegisteredHostNotFound
      | HostTokenRecordAlreadyExists
      | HostTokenInvariantViolation
      | HostTokenStoreError
    >;
    readonly findByHash: (
      tokenHash: HostTokenHash,
    ) => Effect.Effect<
      Option.Option<HostTokenRecord>,
      HostTokenInvariantViolation | HostTokenStoreError
    >;
    readonly revoke: (
      input: RevokeHostTokenRecordInput,
    ) => Effect.Effect<
      HostTokenRecord,
      HostTokenNotFound | HostTokenInvariantViolation | HostTokenStoreError
    >;
  }
>()("@ptools/host-authorization/HostTokenRecordStore") {}
