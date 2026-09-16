/*
 * Shared host machine-token lifecycle coverage.
 *
 * What this proves:
 * 1. Issuance draws 256 secure bits, hashes the complete prefixed credential,
 *    stores only a hash/audit record, and returns plaintext after persistence.
 * 2. Verification uses one digest lookup and preserves the stored host/grants
 *    while collapsing malformed, absent, expired, and revoked credentials.
 * 3. Revocation is host-scoped, immediately visible, and idempotently preserves
 *    the first timestamp and admitted Principal revoker.
 * 4. Crypto and store failures stay distinct from ordinary rejection.
 * 5. Inventory projection rejects duplicate, unordered, cross-Host, and
 *    oversized pages published by a misbehaving platform store.
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
  Result,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  HostPermissions,
  HostTokenHash,
  HostTokenId,
  HostTokenInvariantViolation,
  HostTokenName,
  HostTokenNotFound,
  HostTokenPermissionSelection,
  HostTokenRecord,
  HostTokenPagination,
  HostTokenRejected,
  HostTokenStoreError,
  IssueHostTokenInput,
  ListAllHostTokensInput,
  ListHostTokensInput,
  Pagination,
  RevokeHostTokenInput,
  PrincipalIds,
  PrincipalCaller,
  VerifyHostTokenInput,
} from "../src/contracts/index.js";
import {
  HostTokenRecordStore,
  HostTokenService,
} from "../src/services/index.js";

// These callers are already-authenticated application values. Supplying them
// separately from request DTOs proves the service records trusted admission
// identity rather than accepting caller-authored audit fields.
const issuer = PrincipalCaller.make({
  principalId: PrincipalIds.fromFixedLocalIdentity("issuer-1"),
});
const revoker = PrincipalCaller.make({
  principalId: PrincipalIds.fromFixedLocalIdentity("revoker-1"),
});
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
  // Distinguishes successive random draws so two issued tokens never collide
  // on secret, digest, or token ID in the records map.
  randomCall = 0;
  // Store-misbehavior switches for the inventory-law tests. Each test enables
  // exactly one corruption so a failing list assertion attributes to a single
  // violated invariant rather than a combination.
  duplicateInventory = false;
  unorderedInventory = false;
  foreignHostInventory = false;
  oversizedInventory = false;
  // When set, both listing methods publish this cursor as the store's claimed
  // continuation. It lets the relay test drive a valid but deliberately
  // unrelated-to-items cursor through the service boundary.
  storeNextCursor: Option.Option<HostTokenPagination.Cursor> = Option.none();

  /**
   * Applies at most one inventory corruption to a store result. Corruption
   * happens after host filtering and lookup, emulating a broken platform
   * adapter rather than a caller reaching records it should not see.
   */
  private corruptInventory(
    records: Array<HostTokenRecord>,
  ): Array<HostTokenRecord> {
    if (this.duplicateInventory && records.length > 0) {
      return [...records, records[0]!];
    }
    if (this.unorderedInventory && records.length > 1) {
      return [...records].reverse();
    }
    if (this.foreignHostInventory && records.length > 0) {
      const record = records[0]!;
      return [
        ...records,
        HostTokenRecord.make({
          ...record,
          tokenId: HostTokenId.make("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"),
          tokenHash: HostTokenHash.make(
            createHash("sha256").update("foreign").digest("base64url"),
          ),
          hostId: "other-host",
        }),
      ];
    }
    return records;
  }

  /**
   * Applies the requested database bound unless the test intentionally models
   * a broken adapter returning one lookahead row as a published item. Real
   * stores may fetch `limit + 1` to discover continuation, but that extra row
   * must never cross the `HostTokenRecordStore` boundary.
   */
  private pageInventory(
    records: Array<HostTokenRecord>,
    limit: number,
  ): Array<HostTokenRecord> {
    const publishedLimit = this.oversizedInventory ? limit + 1 : limit;
    return this.corruptInventory(records).slice(0, publishedLimit);
  }

  // Effect's real Crypto constructor still owns UUID formatting. The fake only
  // supplies deterministic primitive bytes and SHA-256 so assertions can prove
  // which input crossed the crypto boundary without relying on random output.
  readonly crypto = Crypto.make({
    randomBytes: (size) => {
      this.randomByteRequests.push(size);
      const seed = this.randomCall++;
      return Uint8Array.from(
        { length: size },
        (_, index) => (index + seed * 37) % 256,
      );
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
            candidate.hostId === input.hostId &&
            candidate.tokenId === input.tokenId,
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
          issuedByPrincipalId: record.issuedByPrincipalId,
          expiresAtEpochMs: record.expiresAtEpochMs,
          revokedAtEpochMs: Option.some(input.revokedAtEpochMs),
          revokedByPrincipalId: Option.some(input.revokedByPrincipalId),
        });
        harness.recordsByHash.set(revoked.tokenHash, revoked);
        return revoked;
      });
    },
    listByHost: (input) =>
      Effect.sync(() =>
        HostTokenPagination.RecordPage.make({
          items: this.pageInventory(
            [...this.recordsByHash.values()].filter(
              (record) => record.hostId === input.hostId,
            ),
            input.limit,
          ),
          nextCursor: this.storeNextCursor,
        }),
      ),
    listAll: (input) =>
      Effect.sync(() =>
        HostTokenPagination.RecordPage.make({
          items: this.pageInventory(
            [...this.recordsByHash.values()],
            input.limit,
          ),
          nextCursor: this.storeNextCursor,
        }),
      ),
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
        Effect.provide(
          HostTokenService.layer.pipe(Layer.provide(dependencies)),
        ),
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
        Effect.provide(
          HostTokenService.layer.pipe(Layer.provide(dependencies)),
        ),
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

/**
 * Lifecycle laws over the real service Layer with faked platform ports only:
 * hash-only persistence, single fixed-length digest lookup, deliberately
 * indistinguishable credential rejection, first-write-wins revocation audit,
 * and infrastructure failures kept distinct from ordinary rejection.
 */
describe("HostTokenService", () => {
  it("publishes lifecycle and safe inventory operations over the hash-only store port", async () => {
    const harness = new Harness();
    // Inventory reads return records for safe projection but the store still
    // exposes no plaintext recovery capability.
    expect(Object.keys(harness.store).sort()).toEqual([
      "create",
      "findByHash",
      "listAll",
      "listByHost",
      "revoke",
    ]);
    const methods = await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return Object.keys(service).sort();
      }),
    );
    expect(methods).toEqual([
      "issue",
      "listAll",
      "listByHost",
      "revoke",
      "verify",
    ]);
  });

  it("lists safe metadata for one Host or across all Hosts", async () => {
    const harness = new Harness();
    const issued = await harness.issue();
    const inventories = await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        const host = yield* service.listByHost(
          ListHostTokensInput.make({
            hostId: "personal",
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        const all = yield* service.listAll(
          ListAllHostTokensInput.make({
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        return { host, all };
      }),
    );

    expect(inventories.host.items).toEqual([issued.token]);
    expect(inventories.all.items).toEqual([issued.token]);
    expect(inventories.all.items[0]).not.toHaveProperty("tokenHash");
    expect(inventories.all.items[0]).not.toHaveProperty("plaintext");
  });

  /**
   * Proves the inventory projection relays the store's continuation cursor
   * verbatim. Per-page ordering is the only inventory law the service enforces
   * here — items must be ordered by `createdAtEpochMs` with `tokenId` breaking
   * ties within this page — but the service deliberately does NOT validate that
   * the cursor matches the page's last item or any other continuation
   * convention: cursor semantics are owned entirely by the platform store,
   * which may fetch `limit + 1` rows or encode keys however it chooses. The
   * fake supplies a syntactically valid cursor unrelated to the page's records
   * to prove that no hidden cursor/last-item coupling exists.
   *
   * What this proves:
   * 1. A store-published `nextCursor: Option.some(cursor)` survives the
   *    service's projection unchanged for both `listByHost` and `listAll`.
   * 2. A well-ordered page with that cursor passes validation, so cursor
   *    relay and item-order validation are independent laws.
   */
  it("relays a valid store-supplied nextCursor through both inventory operations", async () => {
    const harness = new Harness();
    await harness.issue();
    // A well-formed cursor the fake invented that has no relationship to the
    // single issued record — proving the service relays, not recomputes.
    const storeCursor = HostTokenPagination.makeCursor({
      tokenId: HostTokenId.make("123e4567-e89b-42d3-a456-426614174999"),
      createdAtEpochMs: 42,
    });
    harness.storeNextCursor = Option.some(storeCursor);

    const pages = await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        const host = yield* service.listByHost(
          ListHostTokensInput.make({
            hostId: "personal",
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        const all = yield* service.listAll(
          ListAllHostTokensInput.make({
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        return { host, all };
      }),
    );

    expect(pages.host.nextCursor).toStrictEqual(Option.some(storeCursor));
    expect(pages.all.nextCursor).toStrictEqual(Option.some(storeCursor));
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
    expect(stored.issuedByPrincipalId).toBe(issuer.principalId);
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
    if (Exit.isFailure(exit))
      expect(String(exit.cause)).toContain("HostTokenStoreError");
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

  /**
   * Proves strict format routing happens before hashing/storage, so
   * malformed or unsupported versions cannot probe the persistence index.
   */
  it.each(["malformed", `ptools_host_v2_${"A".repeat(43)}`])(
    "rejects malformed credential %s before lookup",
    async (plaintext) => {
      const harness = new Harness();
      const exit = await harness.runExit(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.verify(
            VerifyHostTokenInput.make({ plaintext }),
          );
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
        return yield* service.verify(
          VerifyHostTokenInput.make({ plaintext: canonicalMissing }),
        );
      }),
    );
    expect(String(missingExit)).toContain("HostTokenRejected");

    const harness = new Harness();
    const issued = await harness.issue(Option.some(2_000));
    harness.now = 2_000;
    const expiredExit = await harness.runExit(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.verify(
          VerifyHostTokenInput.make({ plaintext: issued.plaintext }),
        );
      }),
    );
    expect(String(expiredExit)).toContain("HostTokenRejected");

    harness.now = 1_500;
    await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.revoke(
          RevokeHostTokenInput.make({
            hostId: "personal",
            tokenId: issued.token.tokenId,
          }),
          revoker,
        );
      }),
    );
    const revokedExit = await harness.runExit(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* service.verify(
          VerifyHostTokenInput.make({ plaintext: issued.plaintext }),
        );
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
            RevokeHostTokenInput.make({
              hostId,
              tokenId: issued.token.tokenId,
            }),
            caller,
          );
        }),
      );

    // Knowing a token UUID is insufficient to revoke it through another host.
    await expect(revoke("other-host")).rejects.toMatchObject({
      _tag: "HostTokenNotFound",
    });
    const first = await revoke("personal");
    harness.now = 1_200;
    // A later revoker and later clock value must not rewrite first-revocation audit.
    const second = await revoke(
      "personal",
      PrincipalCaller.make({
        principalId: PrincipalIds.fromFixedLocalIdentity("other-revoker"),
      }),
    );
    expect(Option.getOrThrow(first.revokedAtEpochMs)).toBe(1_100);
    expect(Option.getOrThrow(first.revokedByPrincipalId)).toBe(
      revoker.principalId,
    );
    expect(second.revokedAtEpochMs).toEqual(first.revokedAtEpochMs);
    expect(second.revokedByPrincipalId).toEqual(first.revokedByPrincipalId);
  });

  it("fails the inventory when the store returns misbehaved records", async () => {
    // The service validates store output on every list: duplicate management
    // keys, broken creation ordering, and cross-host leakage are platform
    // adapter bugs surfaced as invariant violations, never passed through.
    const duplicate = new Harness();
    await duplicate.issue();
    duplicate.duplicateInventory = true;
    await expect(
      duplicate.run(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.listAll(
            ListAllHostTokensInput.make({
              limit: Pagination.PageSize.make(10),
              cursor: Option.none(),
            }),
          );
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HostTokenInvariantViolation" });

    const unordered = new Harness();
    await unordered.issue();
    unordered.now = 1_100;
    await unordered.issue();
    unordered.unorderedInventory = true;
    await expect(
      unordered.run(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.listAll(
            ListAllHostTokensInput.make({
              limit: Pagination.PageSize.make(10),
              cursor: Option.none(),
            }),
          );
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HostTokenInvariantViolation" });

    // Host scoping applies to the host-scoped listing only, so the foreign
    // record is injected into that path's result.
    const foreign = new Harness();
    await foreign.issue();
    foreign.foreignHostInventory = true;
    await expect(
      foreign.run(
        Effect.gen(function* () {
          const service = yield* HostTokenService;
          return yield* service.listByHost(
            ListHostTokensInput.make({
              hostId: "personal",
              limit: Pagination.PageSize.make(10),
              cursor: Option.none(),
            }),
          );
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HostTokenInvariantViolation" });
  });

  it("rejects oversized pages from both token inventory operations", async () => {
    const harness = new Harness();
    await harness.issue();
    await harness.issue();
    harness.oversizedInventory = true;

    // The fake publishes two records for a one-record request. This models a
    // store accidentally exposing its lookahead row instead of retaining it
    // only long enough to calculate nextCursor.
    const failures = await harness.run(
      Effect.gen(function* () {
        const service = yield* HostTokenService;
        return yield* Effect.all([
          Effect.result(
            service.listAll(
              ListAllHostTokensInput.make({
                limit: Pagination.PageSize.make(1),
                cursor: Option.none(),
              }),
            ),
          ),
          Effect.result(
            service.listByHost(
              ListHostTokensInput.make({
                hostId: "personal",
                limit: Pagination.PageSize.make(1),
                cursor: Option.none(),
              }),
            ),
          ),
        ]);
      }),
    );

    for (const failure of failures) {
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure).toBeInstanceOf(HostTokenInvariantViolation);
      }
    }
  });

  it("rejects issuance expiry that is not strictly in the future before persistence", async () => {
    const harness = new Harness();
    await expect(harness.issue(Option.some(harness.now))).rejects.toMatchObject(
      {
        _tag: "HostTokenExpirationInvalid",
      },
    );
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
          return yield* service.verify(
            VerifyHostTokenInput.make({ plaintext: issued.plaintext }),
          );
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HostTokenStoreError" });
  });
});
