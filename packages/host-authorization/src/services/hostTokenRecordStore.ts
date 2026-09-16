/**
 * Port contract for platform persistence of hash-only host-token records;
 * the shared lifecycle consumes it, platform packages implement it.
 * Ownership, invariants, and per-method laws are documented on the service
 * class below.
 */
import { Context, Effect, Option } from "effect";
import type { RegisteredHostNotFound } from "../contracts/hostAccessErrors.js";
import type { HostTokenHash, HostTokenRecord } from "../contracts/hostToken.js";
import type {
  HostTokenInvariantViolation,
  HostTokenNotFound,
  HostTokenRecordAlreadyExists,
  HostTokenStoreError,
} from "../contracts/hostTokenErrors.js";
import type {
  ListAllHostTokensInput,
  ListHostTokensInput,
} from "../contracts/hostTokenOperations/listHostTokens.js";
import type { RevokeHostTokenRecordInput } from "../contracts/hostTokenOperations/revokeHostToken.js";
import type { HostTokenPagination } from "../contracts/hostTokenPagination.js";

/**
 * Platform-owned persistence capability for hash-only host-token records.
 *
 * Ownership: this is a port, not an implementation. The shared lifecycle
 * (`HostTokenService`) is the only intended consumer; SQLite/D1 adapters live
 * in platform packages and supply this service as a Layer after strictly
 * decoding their private physical representation (rows, JSON, RPC payloads)
 * into the validated contract types below.
 *
 * Security invariants every implementation must uphold:
 * - no method accepts, returns, lists, or reconstructs plaintext; the digest
 *   (`HostTokenHash`) is the only credential-derived value that crosses this
 *   boundary in either direction;
 * - `tokenId` and `tokenHash` are each unique across all records;
 * - persisted records are strictly decoded, never partially defaulted — a
 *   stored value that fails its contract is `HostTokenInvariantViolation`, not
 *   a coerced best effort;
 * - revocation is an atomic host-scoped compare/set (see `revoke`).
 *
 * Error discipline: `HostTokenInvariantViolation` means trusted store output
 * contradicted a shared contract (an implementation or data problem that
 * callers must not downgrade to a credential rejection or expected absence);
 * `HostTokenStoreError` is the wire-safe infrastructure failure carrying no
 * SQL, row, or digest detail.
 */
export class HostTokenRecordStore extends Context.Service<
  HostTokenRecordStore,
  {
    /**
     * Persists a fully validated, hash-only record from the shared lifecycle's
     * `issue` step. Implementations must enforce both uniqueness constraints:
     * a repeated `tokenId` or `tokenHash` fails with
     * `HostTokenRecordAlreadyExists` rather than upserting or mutating the
     * first record. `RegisteredHostNotFound` fails fast when the record's host
     * does not exist, so tokens can never dangle outside a registered Host.
     * The returned record must equal the input; the service treats any
     * divergence as an invariant break.
     */
    readonly create: (
      record: HostTokenRecord,
    ) => Effect.Effect<
      HostTokenRecord,
      | RegisteredHostNotFound
      | HostTokenRecordAlreadyExists
      | HostTokenInvariantViolation
      | HostTokenStoreError
    >;
    /**
     * The single authentication lookup: maps one digest to at most one
     * record. Absence is expected, not an error — an unknown, expired, or
     * revoked token yields `None`, and the lifecycle collapses it into the
     * deliberately indistinguishable `HostTokenRejected`. Because the lookup
     * key is the digest itself, a caller can only reach a record by already
     * possessing a credential that hashes to it.
     */
    readonly findByHash: (
      tokenHash: HostTokenHash,
    ) => Effect.Effect<
      Option.Option<HostTokenRecord>,
      HostTokenInvariantViolation | HostTokenStoreError
    >;
    /**
     * The atomic, host-scoped mutation seam. The record is addressed by
     * `(hostId, tokenId)` together; a known `tokenId` under a different host
     * produces the same `HostTokenNotFound`, so knowing a token's UUID alone
     * neither reveals nor revokes it. Idempotent with first-write-wins audit:
     * revoking an already-revoked token returns the existing record unchanged,
     * never overwriting the first revocation time or revoker identity.
     * Implementations must make the compare/set atomic across concurrent
     * revocations.
     */
    readonly revoke: (
      input: RevokeHostTokenRecordInput,
    ) => Effect.Effect<
      HostTokenRecord,
      HostTokenNotFound | HostTokenInvariantViolation | HostTokenStoreError
    >;
    /**
     * One bounded keyset page for a Host, ordered by `createdAtEpochMs` then
     * `tokenId`. The lifecycle validates ordering and Host scoping on every
     * result and fails with `HostTokenInvariantViolation` if the store violates
     * either, so implementations must apply the limit before publication.
     * Consumed only after the caller has been admitted for host-scoped
     * token management.
     */
    readonly listByHost: (
      input: ListHostTokensInput,
    ) => Effect.Effect<
      HostTokenPagination.RecordPage,
      HostTokenInvariantViolation | HostTokenStoreError
    >;
    /**
     * One bounded cross-Host page with the same keyset contract as `listByHost`.
     * Deliberately unscoped: admission to use it is owned by the management
     * boundary (Administrator authorization), not by this port — the store
     * performs no access checks itself.
     */
    readonly listAll: (
      input: ListAllHostTokensInput,
    ) => Effect.Effect<
      HostTokenPagination.RecordPage,
      HostTokenInvariantViolation | HostTokenStoreError
    >;
  }
>()("@ptools/host-authorization/HostTokenRecordStore") {}
