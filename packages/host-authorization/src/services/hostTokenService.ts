/**
 * Shared cryptographic and persistence lifecycle for host machine tokens.
 *
 * Callers of issue/revoke have already been authenticated and authorized by a
 * later admission boundary. This service trusts the supplied
 * `PrincipalCaller`, performs no request admission, and never gives
 * plaintext to persistence.
 */
import { Clock, Context, Crypto, Effect, Equal, Layer, Option, Schema } from "effect";
import type { PrincipalCaller } from "../contracts/hostCaller.js";
import {
  HostTokenId,
} from "../contracts/hostTokenIdentity.js";
import {
  HostTokenRecord,
  IssuedHostToken,
  type HostToken,
  type VerifiedHostToken,
} from "../contracts/hostToken.js";
import {
  HostTokenCryptoError,
  HostTokenExpirationInvalid,
  HostTokenInvariantViolation,
  HostTokenRejected,
  type HostTokenOperation,
} from "../contracts/hostTokenErrors.js";
import type {
  IssueHostTokenError,
  IssueHostTokenInput,
} from "../contracts/hostTokenOperations/issueHostToken.js";
import type {
  ListAllHostTokensInput,
  ListHostTokensError,
  ListHostTokensInput,
} from "../contracts/hostTokenOperations/listHostTokens.js";
import {
  RevokeHostTokenRecordInput,
  type RevokeHostTokenError,
  type RevokeHostTokenInput,
} from "../contracts/hostTokenOperations/revokeHostToken.js";
import type {
  VerifyHostTokenError,
  VerifyHostTokenInput,
} from "../contracts/hostTokenOperations/verifyHostToken.js";
import {
  HOST_TOKEN_SECRET_BYTES,
  makeV1HostTokenCredential,
  parseV1HostTokenCredential,
} from "../hostTokenCredential.js";
import { hashHostTokenCredential, timingSafeDigestEquals } from "../hostTokenHashing.js";
import {
  isHostTokenActiveAt,
  projectSafeHostToken,
  projectVerifiedHostToken,
} from "../hostTokenProjection.js";
import { HostTokenRecordStore } from "./hostTokenRecordStore.js";

/**
 * Maps a platform crypto failure onto the wire-safe diagnostic error.
 *
 * The operation type is deliberately narrower than `HostTokenOperation`:
 * only `issue` (random secret, token UUID) and `verify` (credential
 * digesting, via `hashHostTokenCredential`) perform platform crypto work, so
 * a crypto failure attributed to `revoke` or `list` would be a false
 * diagnostic. `Extract` ties the literals to the contract so a rename there
 * fails here too, while contract additions do not widen this set — widening
 * is a semantic change to make together with the crypto call site that
 * justifies it, not a cleanup.
 */
const cryptoFailure = (
  operation: Extract<HostTokenOperation, "issue" | "verify">,
) =>
  (error: Error) => new HostTokenCryptoError({ operation, message: error.message });

const invariant = (operation: HostTokenOperation, message: string) =>
  new HostTokenInvariantViolation({ operation, message });

/**
 * Package-owned machine-token lifecycle composed from platform crypto and the
 * hash-only record store.
 *
 * `issue` creates and persists a credential after receiving a separately
 * admitted Principal-caller caller; `verify` turns an untrusted bearer string
 * into request-scoped token authority; `revoke` records the separately admitted
 * Principal caller. This service intentionally does not verify credentials,
 * resolve host membership, run authorization policies, parse HTTP, or compare
 * a verified token's host binding with a route host—later Host API admission
 * owns those steps and calls these methods only at the appropriate seam.
 */
export class HostTokenService extends Context.Service<HostTokenService>()(
  "@ptools/host-authorization/HostTokenService",
  {
    make: Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const recordStore = yield* HostTokenRecordStore;

      const issue = (
        input: IssueHostTokenInput,
        issuer: PrincipalCaller,
      ): Effect.Effect<IssuedHostToken, IssueHostTokenError> =>
        Effect.gen(function* () {
          const createdAtEpochMs = yield* Clock.currentTimeMillis;
          if (
            Option.isSome(input.expiresAtEpochMs) &&
            input.expiresAtEpochMs.value <= createdAtEpochMs
          ) {
            return yield* new HostTokenExpirationInvalid({
              message: "token expiry must be later than issuance time",
            });
          }

          const secret = yield* crypto.randomBytes(HOST_TOKEN_SECRET_BYTES).pipe(
            Effect.mapError(cryptoFailure("issue")),
          );
          const plaintext = yield* Option.match(
            makeV1HostTokenCredential(secret),
            {
              onNone: () =>
                Effect.fail(
                  invariant("issue", "secure random source returned the wrong byte length"),
                ),
              onSome: Effect.succeed,
            },
          );
          const tokenHash = yield* hashHostTokenCredential(
            crypto,
            plaintext,
            "issue",
          );
          const rawTokenId = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(cryptoFailure("issue")),
          );
          const tokenId = yield* Schema.decodeUnknownEffect(HostTokenId)(rawTokenId).pipe(
            Effect.mapError(() =>
              invariant("issue", "crypto service returned an invalid UUIDv4"),
            ),
          );
          const record = yield* HostTokenRecord.makeEffect({
            tokenHash,
            tokenId,
            hostId: input.hostId,
            name: input.name,
            grantedPermissions: input.grantedPermissions,
            createdAtEpochMs,
            issuedByPrincipalId: issuer.principalId,
            expiresAtEpochMs: input.expiresAtEpochMs,
            revokedAtEpochMs: Option.none(),
            revokedByPrincipalId: Option.none(),
          }).pipe(
            Effect.mapError(() =>
              invariant("issue", "issued token record violated its lifecycle contract"),
            ),
          );
          const persisted = yield* recordStore.create(record);
          if (!Equal.equals(record, persisted)) {
            return yield* invariant(
              "issue",
              "create returned a record different from the issued record",
            );
          }
          return IssuedHostToken.make({
            plaintext,
            token: projectSafeHostToken(persisted),
          });
        });

      const verify = (
        input: VerifyHostTokenInput,
      ): Effect.Effect<VerifiedHostToken, VerifyHostTokenError> =>
        Effect.gen(function* () {
          const plaintext = yield* Option.match(
            parseV1HostTokenCredential(input.plaintext),
            {
              onNone: () =>
                Effect.fail(
                  new HostTokenRejected({ message: "host token was rejected" }),
                ),
              onSome: Effect.succeed,
            },
          );
          const tokenHash = yield* hashHostTokenCredential(
            crypto,
            plaintext,
            "verify",
          );
          const found = yield* recordStore.findByHash(tokenHash);
          const record = yield* Option.match(found, {
            onNone: () =>
              Effect.fail(new HostTokenRejected({ message: "host token was rejected" })),
            onSome: Effect.succeed,
          });
          // Store output was already keyed by this digest, so this check fires
          // only on a broken store (hence the invariant, not a rejection). See
          // timingSafeDigestEquals for why the comparison itself is constant-time.
          if (!timingSafeDigestEquals(record.tokenHash, tokenHash)) {
            return yield* invariant(
              "verify",
              "hash lookup returned a record for a different digest",
            );
          }
          const now = yield* Clock.currentTimeMillis;
          if (!isHostTokenActiveAt(record, now)) {
            return yield* new HostTokenRejected({ message: "host token was rejected" });
          }
          return projectVerifiedHostToken(record);
        });

      const revoke = (
        input: RevokeHostTokenInput,
        revoker: PrincipalCaller,
      ): Effect.Effect<HostToken, RevokeHostTokenError> =>
        Effect.gen(function* () {
          const revokedAtEpochMs = yield* Clock.currentTimeMillis;
          const record = yield* recordStore.revoke(
            RevokeHostTokenRecordInput.make({
              hostId: input.hostId,
              tokenId: input.tokenId,
              revokedAtEpochMs,
              revokedByPrincipalId: revoker.principalId,
            }),
          );
          if (
            record.hostId !== input.hostId ||
            record.tokenId !== input.tokenId ||
            Option.isNone(record.revokedAtEpochMs) ||
            Option.isNone(record.revokedByPrincipalId) ||
            record.revokedAtEpochMs.value > revokedAtEpochMs
          ) {
            return yield* invariant(
              "revoke",
              "revoke returned an inconsistent host-scoped token record",
            );
          }
          return projectSafeHostToken(record);
        });

      const projectTokenInventory = (
        records: ReadonlyArray<HostTokenRecord>,
        expectedHostId?: string,
      ): Effect.Effect<ReadonlyArray<HostToken>, HostTokenInvariantViolation> => {
        const hasDuplicate =
          new Set(records.map((record) => record.tokenId)).size !== records.length;
        const isOrdered = records.every((record, index) => {
          const previous = records[index - 1];
          return (
            previous === undefined ||
            previous.createdAtEpochMs < record.createdAtEpochMs ||
            (previous.createdAtEpochMs === record.createdAtEpochMs &&
              previous.tokenId < record.tokenId)
          );
        });
        const hasWrongHost =
          expectedHostId !== undefined &&
          records.some((record) => record.hostId !== expectedHostId);

        return hasDuplicate || !isOrdered || hasWrongHost
          ? Effect.fail(
              invariant(
                "list",
                "token inventory violated Host scope, uniqueness, or ordering",
              ),
            )
          : Effect.succeed(records.map(projectSafeHostToken));
      };

      const listByHost = (
        input: ListHostTokensInput,
      ): Effect.Effect<ReadonlyArray<HostToken>, ListHostTokensError> =>
        recordStore.listByHost(input.hostId).pipe(
          Effect.flatMap((records) =>
            projectTokenInventory(records, input.hostId),
          ),
        );

      const listAll = (
        _input: ListAllHostTokensInput,
      ): Effect.Effect<ReadonlyArray<HostToken>, ListHostTokensError> =>
        recordStore.listAll().pipe(
          Effect.flatMap((records) => projectTokenInventory(records)),
        );

      return { issue, verify, revoke, listByHost, listAll } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
