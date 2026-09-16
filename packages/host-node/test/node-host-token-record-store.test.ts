/**
 * Durable hash-only Host-token record coverage.
 *
 * Mental model: shared issuance supplies a complete validated record containing
 * only a bearer digest; Node persists and retrieves that record without ever
 * receiving plaintext, while revocation atomically preserves its first audit.
 *
 * What this proves:
 *   1. Create/find/list reproduce a complete hash-only record.
 *   2. Token ID and digest collisions return the shared collision error.
 *   3. Repeated revocation is first-write-wins.
 *   4. Global and Host-scoped token pages both traverse timestamp ties by
 *      token ID without skips or duplicates.
 *
 * Boundaries: the database, migrations, foreign keys, and transactions are real.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaimInitialAdministratorRecordInput,
  ControlPlaneSetupCapabilityHash,
  CreateOwnedHostInput,
  HostPermissions,
  HostTokenHash,
  HostTokenId,
  HostTokenInvariantViolation,
  HostTokenName,
  HostTokenRecord,
  HostTokenRecordAlreadyExists,
  InitializeControlPlaneInput,
  ListAllHostTokensInput,
  ListHostTokensInput,
  Pagination,
  PrincipalIds,
  RevokeHostTokenRecordInput,
} from "@ptools/host-authorization";
import {
  ControlPlaneAccessStore,
  HostAccessStore,
  HostTokenRecordStore,
} from "@ptools/host-authorization/effect";
import { eq } from "drizzle-orm";
import { Effect, Encoding, Layer, Option, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeAuthorizationStoresLive } from "../src/hostControlPlaneDaemon/authorization/nodeAuthorizationStores.js";
import { hostTokenTable } from "../src/hostControlPlaneDaemon/persistence/nodeControlPlaneSqliteSchema.js";
import {
  NodeControlPlaneDrizzle,
  NodeControlPlaneDrizzleLive,
} from "../src/services/nodeControlPlaneDrizzle.js";

let directory: string;
let filename: string;

const principalId = PrincipalIds.fromFixedLocalIdentity("token-test/operator");
const setupCapabilityHash = ControlPlaneSetupCapabilityHash.make(
  "c".repeat(43),
);
const tokenId = HostTokenId.make("123e4567-e89b-42d3-a456-426614174000");
const tokenHash = HostTokenHash.make(
  Encoding.encodeBase64Url(new Uint8Array(32).fill(7)),
);
const otherTokenId = HostTokenId.make("123e4567-e89b-42d3-a456-426614174001");
const otherTokenHash = HostTokenHash.make(
  Encoding.encodeBase64Url(new Uint8Array(32).fill(8)),
);

const live = () =>
  NodeAuthorizationStoresLive.pipe(
    Layer.provideMerge(NodeControlPlaneDrizzleLive({ filename })),
  );

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | ControlPlaneAccessStore
    | HostAccessStore
    | HostTokenRecordStore
    | NodeControlPlaneDrizzle
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(live())));

const provision = Effect.gen(function* () {
  const control = yield* ControlPlaneAccessStore;
  yield* control.initialize(
    InitializeControlPlaneInput.make({ setupCapabilityHash }),
  );
  yield* control.claimInitialAdministrator(
    ClaimInitialAdministratorRecordInput.make({
      principalId,
      setupCapabilityHash,
      claimedAtEpochMs: 1,
    }),
  );
  const hosts = yield* HostAccessStore;
  yield* hosts.createOwnedHost(
    CreateOwnedHostInput.make({
      requestedHostId: "node-local",
      ownerPrincipalId: principalId,
    }),
  );
});

const record = HostTokenRecord.make({
  tokenId,
  tokenHash,
  hostId: "node-local",
  name: HostTokenName.make("automation"),
  grantedPermissions: [HostPermissions.host.read],
  createdAtEpochMs: 10,
  issuedByPrincipalId: principalId,
  expiresAtEpochMs: Option.none(),
  revokedAtEpochMs: Option.none(),
  revokedByPrincipalId: Option.none(),
});

describe("Node HostTokenRecordStore", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ptools-host-token-store-"));
    filename = join(directory, "control-plane.sqlite");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Proves the store is a faithful, hash-only record keeper.
   *
   * A complete `HostTokenRecord` is written, then read back through all three
   * shapes — point create/return, digest lookup (`findByHash`, the path token
   * authentication uses), Host-scoped listing, and global listing. Every
   * projection must equal the original record exactly: no field dropped,
   * defaulted, or transformed. "Hash-only" is the security boundary: the
   * store persists a bearer digest and never receives or returns plaintext,
   * so retrieval by digest must be the ONLY lookup key for verification.
   */
  it("creates, finds, and lists the complete hash-only record", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* provision;
        const tokens = yield* HostTokenRecordStore;
        const created = yield* tokens.create(record);
        const found = yield* tokens.findByHash(tokenHash);
        const listed = yield* tokens.listByHost(
          ListHostTokensInput.make({
            hostId: "node-local",
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        const all = yield* tokens.listAll(
          ListAllHostTokensInput.make({
            limit: Pagination.PageSize.make(10),
            cursor: Option.none(),
          }),
        );
        return { created, found, listed, all };
      }),
    );

    expect(result.created).toEqual(record);
    expect(Option.getOrThrow(result.found)).toEqual(record);
    expect(result.listed.items).toEqual([record]);
    expect(result.all.items).toEqual([record]);
  });

  /**
   * Proves token pagination is deterministic when sort keys tie.
   *
   * Both tokens share the same `createdAtEpochMs` (copied from one record),
   * so ordering must fall through to a stable tiebreaker (token ID). Walking
   * two pages of one item through BOTH cursors — global `listAll` and
   * Host-scoped `listByHost` — must emit each token exactly once with no
   * skip, repeat, or reordering, and terminate cleanly on the second page.
   * Timestamp ties are the classic keyset-pagination corruption: a naive
   * `WHERE createdAt > cursor` seek would drop the tied row on resume.
   */
  it("continues global and Host-scoped pages through timestamp ties", async () => {
    const pages = await run(
      Effect.gen(function* () {
        yield* provision;
        const tokens = yield* HostTokenRecordStore;
        const secondRecord = HostTokenRecord.make({
          ...record,
          tokenId: otherTokenId,
          tokenHash: otherTokenHash,
        });
        yield* tokens.create(record);
        yield* tokens.create(secondRecord);

        const firstAll = yield* tokens.listAll(
          ListAllHostTokensInput.make({
            limit: Pagination.PageSize.make(1),
            cursor: Option.none(),
          }),
        );
        const secondAll = yield* tokens.listAll(
          ListAllHostTokensInput.make({
            limit: Pagination.PageSize.make(1),
            cursor: firstAll.nextCursor,
          }),
        );
        const firstByHost = yield* tokens.listByHost(
          ListHostTokensInput.make({
            hostId: "node-local",
            limit: Pagination.PageSize.make(1),
            cursor: Option.none(),
          }),
        );
        const secondByHost = yield* tokens.listByHost(
          ListHostTokensInput.make({
            hostId: "node-local",
            limit: Pagination.PageSize.make(1),
            cursor: firstByHost.nextCursor,
          }),
        );
        return { firstAll, secondAll, firstByHost, secondByHost };
      }),
    );

    const expected = [
      record,
      HostTokenRecord.make({
        ...record,
        tokenId: otherTokenId,
        tokenHash: otherTokenHash,
      }),
    ];
    expect([...pages.firstAll.items, ...pages.secondAll.items]).toEqual(
      expected,
    );
    expect([...pages.firstByHost.items, ...pages.secondByHost.items]).toEqual(
      expected,
    );
    expect(Option.isSome(pages.firstAll.nextCursor)).toBe(true);
    expect(Option.isSome(pages.firstByHost.nextCursor)).toBe(true);
    expect(Option.isNone(pages.secondAll.nextCursor)).toBe(true);
    expect(Option.isNone(pages.secondByHost.nextCursor)).toBe(true);
  });

  /**
   * Proves both uniqueness dimensions of a token record are enforced, and
   * that both surface as the SAME typed error.
   *
   * Two distinct collisions are attempted against one stored record: reusing
   * the token ID with a different digest, and reusing the digest with a
   * different token ID. Both must fail with `HostTokenRecordAlreadyExists`.
   * One shared error is deliberate: ID collision means a minting bug, digest
   * collision means the same bearer secret was issued twice — callers audit
   * it identically, and the store does not leak which column tripped.
   */
  it("maps token ID and digest uniqueness collisions to the shared error", async () => {
    const collisions = await run(
      Effect.gen(function* () {
        yield* provision;
        const tokens = yield* HostTokenRecordStore;
        yield* tokens.create(record);
        const duplicateId = HostTokenRecord.make({
          ...record,
          tokenHash: otherTokenHash,
        });
        const duplicateHash = HostTokenRecord.make({
          ...record,
          tokenId: otherTokenId,
        });
        return yield* Effect.all([
          Effect.result(tokens.create(duplicateId)),
          Effect.result(tokens.create(duplicateHash)),
        ]);
      }),
    );

    for (const collision of collisions) {
      expect(Result.isFailure(collision)).toBe(true);
      if (Result.isFailure(collision)) {
        expect(collision.failure).toBeInstanceOf(HostTokenRecordAlreadyExists);
      }
    }
  });

  /**
   * Proves persisted token grants are strictly decoded, never tolerated.
   *
   * The stored `grantedPermissionsJson` is hand-corrupted with an unknown
   * permission string, and the next read must fail with the typed
   * `HostTokenInvariantViolation` instead of serving the record. A token
   * record IS an authority snapshot frozen at mint time — the one place no
   * store lookup can correct it — so a malformed grant must fail closed on
   * read rather than silently granting an uninterpretable permission. This is
   * the token-store counterpart of the catalog corruption tests above.
   */
  it("fails with an invariant when persisted grant JSON is malformed", async () => {
    const failure = await run(
      Effect.gen(function* () {
        yield* provision;
        const tokens = yield* HostTokenRecordStore;
        yield* tokens.create(record);
        const { database } = yield* NodeControlPlaneDrizzle;
        yield* database
          .update(hostTokenTable)
          .set({ grantedPermissionsJson: '["unknown:permission"]' })
          .where(eq(hostTokenTable.tokenId, tokenId));
        return yield* Effect.result(
          tokens.listByHost(
            ListHostTokensInput.make({
              hostId: "node-local",
              limit: Pagination.PageSize.make(10),
              cursor: Option.none(),
            }),
          ),
        );
      }),
    );

    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) {
      expect(failure.failure).toBeInstanceOf(HostTokenInvariantViolation);
    }
  });

  /**
   * Proves revocation is first-write-wins under a race.
   *
   * Two revocations of the same token run concurrently with different audit
   * timestamps (20 and 30). Both must succeed with the SAME result — the
   * FIRST write's audit fields (revokedAtEpochMs = 20) — never a merge, an
   * overwrite by the later timestamp, or an error for the loser. The
   * revocation audit trail must reflect who actually revoked first, not who
   * wrote last; the atomic conditional update (only revoke if not already
   * revoked) makes exactly one of the racing writes the winner.
   */
  it("keeps the first revocation audit on concurrent repeated revocation", async () => {
    const revoked = await run(
      Effect.gen(function* () {
        yield* provision;
        const tokens = yield* HostTokenRecordStore;
        yield* tokens.create(record);
        const [first, second] = yield* Effect.all(
          [
            tokens.revoke(
              RevokeHostTokenRecordInput.make({
                hostId: "node-local",
                tokenId,
                revokedAtEpochMs: 20,
                revokedByPrincipalId: principalId,
              }),
            ),
            tokens.revoke(
              RevokeHostTokenRecordInput.make({
                hostId: "node-local",
                tokenId,
                revokedAtEpochMs: 30,
                revokedByPrincipalId: principalId,
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return { first, second };
      }),
    );

    expect(Option.getOrThrow(revoked.first.revokedAtEpochMs)).toBe(20);
    expect(revoked.second).toEqual(revoked.first);
  });
});
