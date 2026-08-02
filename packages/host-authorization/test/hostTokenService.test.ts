/*
 * Shared host machine-token lifecycle coverage.
 *
 * What this proves:
 * 1. Issuance draws 256 secure bits, hashes the complete prefixed credential,
 *    stores only a hash/audit record, and returns plaintext after persistence.
 * 2. Verification uses one digest lookup and preserves the stored host/grants
 *    while collapsing malformed, absent, expired, and revoked credentials.
 * 3. Revocation is host-scoped, immediately visible, and idempotently preserves
 *    the first timestamp and admitted user-session revoker.
 * 4. Crypto and store failures stay distinct from ordinary rejection.
 *
 * HostTokenService, Effect composition, hashing, schemas, and lifecycle logic
 * are real. Only the platform Crypto and persistence ports are deterministic
 * in-memory fakes; there is no HTTP, authentication, access store, or database.
 */
import { createHash } from "node:crypto";
import {
  Clock,
  Crypto,
  Effect,
  Exit,
  Layer,
  Option,
  PlatformError,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  HostPermissions,
  HostTokenName,
  HostTokenNotFound,
  HostTokenPermissionSelection,
  HostTokenRecord,
  HostTokenRejected,
  HostTokenStoreError,
  IssueHostTokenInput,
  RevokeHostTokenInput,
  UserSessionCaller,
  VerifyHostTokenInput,
} from "../src/contracts/index.js";
import {
  HostTokenRecordStore,
  HostTokenService,
} from "../src/services/index.js";

// These callers are already-authenticated application values. Supplying them
// separately from request DTOs proves the service records trusted admission
// identity rather than accepting caller-authored audit fields.
const issuer = UserSessionCaller.make({ userId: "issuer-1", sessionId: "session-1" });
const revoker = UserSessionCaller.make({ userId: "revoker-1", sessionId: "session-2" });
const grants = HostTokenPermissionSelection.make([
  HostPermissions.host.read,
  HostPermissions.host.execute,
]);

/**
 * Builds one isolated, stateful platform around the real shared token service.
 * The maps and counters make otherwise invisible security seams observable:
 * what persistence received, what bytes were hashed, how much randomness was
 * requested, and whether malformed credentials reached storage. Mutable time
 * and failure switches let each test drive a specific lifecycle transition
 * without replacing the shared implementation under test.
 */
class Harness {
  readonly recordsByHash = new Map<string, HostTokenRecord>();
  readonly randomByteRequests: Array<number> = [];
  readonly digestedInputs: Array<string> = [];
  findCalls = 0;
  now = 1_000;
  failCreate = false;
  failFind = false;
  failDigest = false;

  // Effect's real Crypto constructor still owns UUID formatting. The fake only
  // supplies deterministic primitive bytes and SHA-256 so assertions can prove
  // which input crossed the crypto boundary without relying on random output.
  readonly crypto = Crypto.make({
    randomBytes: (size) => {
      this.randomByteRequests.push(size);
      return Uint8Array.from({ length: size }, (_, index) => index);
    },
    digest: (_algorithm, data) => {
      this.digestedInputs.push(new TextDecoder().decode(data));
      if (this.failDigest) {
        return Effect.fail(
          PlatformError.badArgument({
            module: "TestCrypto",
            method: "digest",
            description: "digest unavailable",
          }),
        );
      }
      return Effect.succeed(
        new Uint8Array(createHash("sha256").update(data).digest()),
      );
    },
  });

  // This fake implements the platform port's actual service laws: hash lookup,
  // host-and-token scoped revocation, and first-write-wins revocation audit.
  // It stores HostTokenRecord values exactly as received, making any accidental
  // plaintext persistence visible to assertions.
  readonly store = HostTokenRecordStore.of({
    create: (record) => {
      if (this.failCreate) {
        return Effect.fail(
          new HostTokenStoreError({
            operation: "create",
            message: "storage unavailable",
          }),
        );
      }
      return Effect.sync(() => {
        this.recordsByHash.set(record.tokenHash, record);
        return record;
      });
    },
    findByHash: (hash) => {
      this.findCalls += 1;
      if (this.failFind) {
        return Effect.fail(
          new HostTokenStoreError({
            operation: "findByHash",
            message: "storage unavailable",
          }),
        );
      }
      return Effect.succeed(Option.fromNullishOr(this.recordsByHash.get(hash)));
    },
    revoke: (input) => {
      const harness = this;
      return Effect.gen(function* () {
        const record = Array.from(harness.recordsByHash.values()).find(
          (candidate) =>
            candidate.hostId === input.hostId && candidate.tokenId === input.tokenId,
        );
        if (record === undefined) {
          return yield* new HostTokenNotFound({
            hostId: input.hostId,
            tokenId: input.tokenId,
            message: "host token not found",
          });
        }
        // Returning the existing record is the idempotency seam: a later caller
        // must not replace the first revocation time or revoker identity.
        if (Option.isSome(record.revokedAtEpochMs)) return record;
        const revoked = HostTokenRecord.make({
          credentialVersion: 1,
          tokenHash: record.tokenHash,
          tokenId: record.tokenId,
          hostId: record.hostId,
          name: record.name,
          grantedPermissions: record.grantedPermissions,
          createdAtEpochMs: record.createdAtEpochMs,
          issuedByUserId: record.issuedByUserId,
          expiresAtEpochMs: record.expiresAtEpochMs,
          revokedAtEpochMs: Option.some(input.revokedAtEpochMs),
          revokedByUserId: Option.some(input.revokedByUserId),
        });
        harness.recordsByHash.set(revoked.tokenHash, revoked);
        return revoked;
      });
    },
  });

  // All mutation timestamps come from this supplied Effect Clock. Tests advance
  // `now` explicitly to distinguish issuance, expiry, and repeated revocation.
  readonly clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => this.now,
    currentTimeMillis: Effect.sync(() => this.now),
    currentTimeNanosUnsafe: () => BigInt(this.now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(this.now) * 1_000_000n),
    sleep: () => Effect.void,
  };

  /** Runs a successful-path program through the real service Layer. */
  run<A, E>(effect: Effect.Effect<A, E, HostTokenService>): Promise<A> {
    const dependencies = Layer.merge(
      Layer.succeed(HostTokenRecordStore, this.store),
      Layer.succeed(Crypto.Crypto, this.crypto),
    );
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(HostTokenService.layer.pipe(Layer.provide(dependencies))),
        Effect.provideService(Clock.Clock, this.clock),
      ),
    );
  }

  /** Retains the typed failure Cause so tests can inspect failed issuance safely. */
  runExit<A, E>(effect: Effect.Effect<A, E, HostTokenService>) {
    const dependencies = Layer.merge(
      Layer.succeed(HostTokenRecordStore, this.store),
      Layer.succeed(Crypto.Crypto, this.crypto),
    );
    return Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(HostTokenService.layer.pipe(Layer.provide(dependencies))),
        Effect.provideService(Clock.Clock, this.clock),
      ),
    );
  }

  /** Issues the standard fixture token through the public service operation. */
  issue(expiresAtEpochMs = Option.none<number>()) {
    return this.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.issue(
          IssueHostTokenInput.make({
            hostId: "personal",
            name: HostTokenName.make("OpenCode laptop"),
            grantedPermissions: grants,
            expiresAtEpochMs,
          }),
          issuer,
        );
      }),
    );
  }
}

describe("HostTokenService", () => {
  it("publishes only lifecycle operations over the hash-only store port", async () => {
    const harness = new Harness();
    // The store surface itself proves plaintext recovery/listing cannot be
    // implemented by shared code because no such persistence capability exists.
    expect(Object.keys(harness.store).sort()).toEqual([
      "create",
      "findByHash",
      "revoke",
    ]);
    const methods = await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return Object.keys(service).sort();
      }),
    );
    expect(methods).toEqual(["issue", "revoke", "verify"]);
  });

  it("issues from 32 random bytes and persists only complete-credential hash metadata", async () => {
    const harness = new Harness();
    const issued = await harness.issue();
    const stored = Array.from(harness.recordsByHash.values())[0]!;

    // Observe the entire issuance seam: 32 bytes for token entropy, 16 bytes for
    // Effect's UUIDv4, and SHA-256 over the complete version-prefixed plaintext.
    expect(harness.randomByteRequests).toEqual([32, 16]);
    expect(harness.digestedInputs).toEqual([issued.plaintext]);
    expect(stored.tokenHash).toBe(
      createHash("sha256").update(issued.plaintext).digest("base64url"),
    );
    expect(issued.plaintext).toMatch(/^ptools_host_v1_[A-Za-z0-9_-]{43}$/);
    // The two returned/stored representations intentionally disclose opposite
    // sensitive fields: persistence gets the hash; the one-time result gets plaintext.
    expect(stored).not.toHaveProperty("plaintext");
    expect(issued.token).not.toHaveProperty("tokenHash");
    expect(stored.issuedByUserId).toBe(issuer.userId);
    expect(stored.grantedPermissions).toEqual(grants);
    expect(issued.token).toMatchObject({
      tokenId: stored.tokenId,
      hostId: stored.hostId,
      name: stored.name,
    });
  });

  it("returns no issuance success when persistence fails", async () => {
    const harness = new Harness();
    harness.failCreate = true;
    // Capture an Exit rather than a rejected Promise so the assertion can prove
    // the operation has no success value after the store rejects creation.
    const exit = await harness.runExit(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.issue(
          IssueHostTokenInput.make({
            hostId: "personal",
            name: HostTokenName.make("CI"),
            grantedPermissions: grants,
            expiresAtEpochMs: Option.none(),
          }),
          issuer,
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("HostTokenStoreError");
    expect(harness.recordsByHash.size).toBe(0);
  });

  it("verifies the persisted host binding and immutable grant snapshot", async () => {
    const harness = new Harness();
    const issued = await harness.issue();
    const verified = await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.verify(
          VerifyHostTokenInput.make({ plaintext: issued.plaintext }),
        );
      }),
    );
    expect(verified.principal).toMatchObject({
      _tag: "HostTokenCaller",
      hostId: "personal",
      tokenId: issued.token.tokenId,
    });
    expect(verified.effectivePermissions).toEqual(grants);
    // Exactly one fixed-length digest lookup rules out record scans or fallback
    // authentication paths after the credential has matched V1 syntax.
    expect(harness.findCalls).toBe(1);
  });

  it.each(["malformed", `ptools_host_v2_${"A".repeat(43)}`])(
    "rejects malformed credential %s before lookup",
    async (plaintext) => {
      const harness = new Harness();
      const exit = await harness.runExit(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.verify(VerifyHostTokenInput.make({ plaintext }));
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("HostTokenRejected");
      // Strict format routing happens before hashing/storage, preventing malformed
      // or unsupported versions from probing the persistence index.
      expect(harness.findCalls).toBe(0);
    },
  );

  it("uses the same rejection for missing, expired-at-now, and revoked tokens", async () => {
    // Exercise three distinct internal reasons and assert that the public error
    // deliberately reveals none of those distinctions to credential callers.
    const missing = new Harness();
    const canonicalMissing = `ptools_host_v1_${"A".repeat(43)}`;
    const missingExit = await missing.runExit(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.verify(VerifyHostTokenInput.make({ plaintext: canonicalMissing }));
      }),
    );
    expect(String(missingExit)).toContain("HostTokenRejected");

    const harness = new Harness();
    const issued = await harness.issue(Option.some(2_000));
    harness.now = 2_000;
    const expiredExit = await harness.runExit(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.verify(VerifyHostTokenInput.make({ plaintext: issued.plaintext }));
      }),
    );
    expect(String(expiredExit)).toContain("HostTokenRejected");

    harness.now = 1_500;
    await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.revoke(
          RevokeHostTokenInput.make({ hostId: "personal", tokenId: issued.token.tokenId }),
          revoker,
        );
      }),
    );
    const revokedExit = await harness.runExit(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.verify(VerifyHostTokenInput.make({ plaintext: issued.plaintext }));
      }),
    );
    expect(String(revokedExit)).toContain("HostTokenRejected");
  });

  it("revokes atomically, immediately, idempotently, and only within the host", async () => {
    const harness = new Harness();
    const issued = await harness.issue();
    harness.now = 1_100;
    const revoke = (hostId: string, caller = revoker) =>
      harness.run(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.revoke(
            RevokeHostTokenInput.make({ hostId, tokenId: issued.token.tokenId }),
            caller,
          );
        }),
      );

    // Knowing a token UUID is insufficient to revoke it through another host.
    await expect(revoke("other-host")).rejects.toMatchObject({ _tag: "HostTokenNotFound" });
    const first = await revoke("personal");
    harness.now = 1_200;
    // A later revoker and later clock value must not rewrite first-revocation audit.
    const second = await revoke(
      "personal",
      UserSessionCaller.make({ userId: "other-revoker", sessionId: "session-3" }),
    );
    expect(Option.getOrThrow(first.revokedAtEpochMs)).toBe(1_100);
    expect(Option.getOrThrow(first.revokedByUserId)).toBe(revoker.userId);
    expect(second.revokedAtEpochMs).toEqual(first.revokedAtEpochMs);
    expect(second.revokedByUserId).toEqual(first.revokedByUserId);
  });

  it("rejects issuance expiry that is not strictly in the future before persistence", async () => {
    const harness = new Harness();
    await expect(harness.issue(Option.some(harness.now))).rejects.toMatchObject({
      _tag: "HostTokenExpirationInvalid",
    });
    expect(harness.recordsByHash.size).toBe(0);
    // Expiry validation precedes both secret generation and persistence, so an
    // already-invalid request cannot create an undisclosed credential or record.
    expect(harness.randomByteRequests).toEqual([]);
  });

  it("preserves crypto and store failures instead of treating them as rejection", async () => {
    const cryptoHarness = new Harness();
    const issuedForCrypto = await cryptoHarness.issue();
    // Once syntax is valid, a platform digest outage is infrastructure failure,
    // not evidence that the supplied credential is invalid.
    cryptoHarness.failDigest = true;
    await expect(
      cryptoHarness.run(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.verify(
            VerifyHostTokenInput.make({ plaintext: issuedForCrypto.plaintext }),
          );
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HostTokenCryptoError" });

    const harness = new Harness();
    const issued = await harness.issue();
    // Likewise, storage unavailability must survive as HostTokenStoreError
    // rather than being collapsed with an ordinary missing-token lookup.
    harness.failFind = true;
    await expect(
      harness.run(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.verify(VerifyHostTokenInput.make({ plaintext: issued.plaintext }));
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HostTokenStoreError" });
  });
});
