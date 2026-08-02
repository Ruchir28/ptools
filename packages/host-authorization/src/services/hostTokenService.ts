/**
 * Shared cryptographic and persistence lifecycle for host machine tokens.
 *
 * Callers of issue/revoke have already been authenticated and authorized by a
 * later admission boundary. This service trusts the supplied UserSessionCaller,
 * performs no request admission, and never gives plaintext to persistence.
 */
import { Clock, Context, Crypto, Effect, Equal, Layer, Option, Schema } from "effect";
import type { UserSessionCaller } from "../contracts/hostCallerPrincipal.js";
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
} from "../contracts/hostTokenErrors.js";
import type {
  IssueHostTokenError,
  IssueHostTokenInput,
} from "../contracts/hostTokenOperations/issueHostToken.js";
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
import { hashHostTokenCredential } from "../hostTokenHashing.js";
import {
  isHostTokenActiveAt,
  projectSafeHostToken,
  projectVerifiedHostToken,
} from "../hostTokenProjection.js";
import { HostTokenRecordStore } from "./hostTokenRecordStore.js";

const cryptoFailure = (operation: "issue" | "verify") => (error: Error) =>
  new HostTokenCryptoError({ operation, message: error.message });

const invariant = (operation: "issue" | "verify" | "revoke", message: string) =>
  new HostTokenInvariantViolation({ operation, message });

/**
 * Package-owned machine-token lifecycle composed from platform crypto and the
 * hash-only record store.
 *
 * `issue` creates and persists a credential after receiving a separately
 * admitted human caller; `verify` turns an untrusted bearer string into
 * request-scoped machine authority; `revoke` records the separately admitted
 * human revoker. This service intentionally does not authenticate sessions,
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
        issuer: UserSessionCaller,
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
            issuedByUserId: issuer.userId,
            expiresAtEpochMs: input.expiresAtEpochMs,
            revokedAtEpochMs: Option.none(),
            revokedByUserId: Option.none(),
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
          if (record.tokenHash !== tokenHash) {
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
        revoker: UserSessionCaller,
      ): Effect.Effect<HostToken, RevokeHostTokenError> =>
        Effect.gen(function* () {
          const revokedAtEpochMs = yield* Clock.currentTimeMillis;
          const record = yield* recordStore.revoke(
            RevokeHostTokenRecordInput.make({
              hostId: input.hostId,
              tokenId: input.tokenId,
              revokedAtEpochMs,
              revokedByUserId: revoker.userId,
            }),
          );
          if (
            record.hostId !== input.hostId ||
            record.tokenId !== input.tokenId ||
            Option.isNone(record.revokedAtEpochMs) ||
            Option.isNone(record.revokedByUserId) ||
            record.revokedAtEpochMs.value > revokedAtEpochMs
          ) {
            return yield* invariant(
              "revoke",
              "revoke returned an inconsistent host-scoped token record",
            );
          }
          return projectSafeHostToken(record);
        });

      return { issue, verify, revoke } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
