/**
 * @file Node SQLite persistence for shared hash-only Host-token records.
 *
 * The shared token lifecycle creates and verifies credentials; this adapter
 * receives only validated hashes and safe metadata. It never receives bearer
 * plaintext and publishes records only after strict row and grant decoding.
 */
import {
  HostTokenInvariantViolation,
  HostTokenNotFound,
  HostTokenRecord,
  HostTokenPagination,
  HostTokenRecordAlreadyExists,
  HostTokenStoreError,
  RegisteredHostNotFound,
  type HostTokenHash,
  type HostTokenRecordStoreOperation,
  type ListAllHostTokensInput,
  type ListHostTokensInput,
  type RevokeHostTokenRecordInput,
} from "@ptools/host-authorization";
import { HostTokenRecordStore } from "@ptools/host-authorization/effect";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import type { EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import { Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { NodeControlPlaneDrizzle } from "../../services/nodeControlPlaneDrizzle.js";
import { HostTokenRowSelectSchema } from "../persistence/nodeControlPlanePersistedSchemas.js";
import {
  decodeHostTokenPermissions,
  encodeHostTokenPermissions,
} from "../persistence/nodeHostTokenPermissionCodec.js";
import {
  hostTokenTable,
  registeredHostTable,
} from "../persistence/nodeControlPlaneSqliteSchema.js";

/**
 * Durable Node implementation of `HostTokenRecordStore` over the caller-owned
 * control-plane database. `HostTokenService` consumes this hash-only port;
 * callers cannot use it to reconstruct or disclose bearer plaintext.
 */
export const NodeHostTokenRecordStoreLive: Layer.Layer<
  HostTokenRecordStore,
  never,
  NodeControlPlaneDrizzle
> = Layer.effect(
  HostTokenRecordStore,
  Effect.gen(function* () {
    const { database } = yield* NodeControlPlaneDrizzle;
    return HostTokenRecordStore.of({
      create: (record) => create(database, record),
      findByHash: (hash) => findByHash(database, hash),
      revoke: (input) => revoke(database, input),
      listByHost: (input) => listByHost(database, input),
      listAll: (input) => listAll(database, input),
    });
  }),
);

const create = (db: EffectSQLiteNodeDatabase, record: HostTokenRecord) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        const hosts = yield* tx
          .select({ hostId: registeredHostTable.hostId })
          .from(registeredHostTable)
          .where(eq(registeredHostTable.hostId, record.hostId));
        if (hosts.length === 0) {
          return yield* new RegisteredHostNotFound({
            hostId: record.hostId,
            message: "registered Host does not exist",
          });
        }
        const collision = yield* tx
          .select({ tokenId: hostTokenTable.tokenId })
          .from(hostTokenTable)
          .where(
            or(
              eq(hostTokenTable.tokenId, record.tokenId),
              eq(hostTokenTable.tokenHash, record.tokenHash),
            ),
          )
          .limit(1);
        if (collision.length > 0) {
          return yield* new HostTokenRecordAlreadyExists({
            message: "Host token record already exists",
          });
        }
        yield* tx.insert(hostTokenTable).values(toInsertRow(record));
        const persisted = yield* loadByTokenId(
          tx,
          record.hostId,
          record.tokenId,
        );
        return yield* Option.match(persisted, {
          onNone: () =>
            Effect.fail(
              invariant(
                "issue",
                "created token was not visible in its transaction",
              ),
            ),
          onSome: Effect.succeed,
        });
      }),
    )
    .pipe(mapStoreError("create"));

const findByHash = (db: EffectSQLiteNodeDatabase, hash: HostTokenHash) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(hostTokenTable)
      .where(eq(hostTokenTable.tokenHash, hash));
    if (rows.length === 0) return Option.none<HostTokenRecord>();
    if (rows.length !== 1) {
      return yield* invariant("verify", "token hash resolved multiple records");
    }
    return Option.some(yield* decodeRecord(rows[0]!, "verify"));
  }).pipe(mapStoreError("findByHash"));

const revoke = (
  db: EffectSQLiteNodeDatabase,
  input: RevokeHostTokenRecordInput,
) =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        const existing = yield* loadByTokenId(tx, input.hostId, input.tokenId);
        if (Option.isNone(existing)) {
          return yield* new HostTokenNotFound({
            hostId: input.hostId,
            tokenId: input.tokenId,
            message: "Host token does not exist",
          });
        }
        if (Option.isSome(existing.value.revokedAtEpochMs))
          return existing.value;

        yield* tx
          .update(hostTokenTable)
          .set({
            revokedAtEpochMs: input.revokedAtEpochMs,
            revokedByPrincipalId: input.revokedByPrincipalId,
          })
          .where(
            and(
              eq(hostTokenTable.hostId, input.hostId),
              eq(hostTokenTable.tokenId, input.tokenId),
            ),
          );
        const updated = yield* loadByTokenId(tx, input.hostId, input.tokenId);
        return yield* Option.match(updated, {
          onNone: () =>
            Effect.fail(invariant("revoke", "revoked token disappeared")),
          onSome: Effect.succeed,
        });
      }),
    )
    .pipe(mapStoreError("revoke"));

const listByHost = (db: EffectSQLiteNodeDatabase, input: ListHostTokensInput) =>
  Effect.gen(function* () {
    const cursor = Option.map(input.cursor, HostTokenPagination.decodeCursor);
    const rows = yield* db
      .select()
      .from(hostTokenTable)
      .where(
        and(eq(hostTokenTable.hostId, input.hostId), tokenAfterCursor(cursor)),
      )
      .orderBy(
        asc(hostTokenTable.createdAtEpochMs),
        asc(hostTokenTable.tokenId),
      )
      .limit(input.limit + 1);
    return yield* makeTokenRecordPage(rows, input.limit);
  }).pipe(mapStoreError("listByHost"));

const listAll = (db: EffectSQLiteNodeDatabase, input: ListAllHostTokensInput) =>
  Effect.gen(function* () {
    const cursor = Option.map(input.cursor, HostTokenPagination.decodeCursor);
    const rows = yield* db
      .select()
      .from(hostTokenTable)
      .where(tokenAfterCursor(cursor))
      .orderBy(
        asc(hostTokenTable.createdAtEpochMs),
        asc(hostTokenTable.tokenId),
      )
      .limit(input.limit + 1);
    return yield* makeTokenRecordPage(rows, input.limit);
  }).pipe(mapStoreError("listAll"));

const tokenAfterCursor = (
  cursor: Option.Option<ReturnType<typeof HostTokenPagination.decodeCursor>>,
) =>
  Option.match(cursor, {
    onNone: () => undefined,
    onSome: (position) =>
      or(
        gt(hostTokenTable.createdAtEpochMs, position.createdAtEpochMs),
        and(
          eq(hostTokenTable.createdAtEpochMs, position.createdAtEpochMs),
          gt(hostTokenTable.tokenId, position.tokenId),
        ),
      ),
  });

const makeTokenRecordPage = (
  rows: ReadonlyArray<typeof hostTokenTable.$inferSelect>,
  limit: number,
) =>
  Effect.gen(function* () {
    const items = yield* Effect.forEach(rows.slice(0, limit), (row) =>
      decodeRecord(row, "list"),
    );
    const last = items.at(-1);
    return HostTokenPagination.RecordPage.make({
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? Option.some(HostTokenPagination.makeCursor(last))
          : Option.none(),
    });
  });

const loadByTokenId = (
  db: EffectSQLiteNodeDatabase,
  hostId: string,
  tokenId: RevokeHostTokenRecordInput["tokenId"],
) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(hostTokenTable)
      .where(
        and(
          eq(hostTokenTable.hostId, hostId),
          eq(hostTokenTable.tokenId, tokenId),
        ),
      );
    if (rows.length === 0) return Option.none<HostTokenRecord>();
    if (rows.length !== 1) {
      return yield* invariant("revoke", "token ID resolved multiple records");
    }
    return Option.some(yield* decodeRecord(rows[0]!, "revoke"));
  });

const decodeRecord = (
  row: typeof hostTokenTable.$inferSelect,
  operation: "issue" | "verify" | "revoke" | "list",
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(HostTokenRowSelectSchema)(
      row,
    ).pipe(
      Effect.mapError(() =>
        invariant(operation, "stored Host token row is invalid"),
      ),
    );
    const grantedPermissions = yield* decodeHostTokenPermissions(
      decoded.grantedPermissionsJson,
    ).pipe(
      Effect.mapError(() =>
        invariant(operation, "stored Host token permissions are invalid"),
      ),
    );
    return yield* HostTokenRecord.makeEffect({
      credentialVersion: decoded.credentialVersion,
      tokenHash: decoded.tokenHash,
      tokenId: decoded.tokenId,
      hostId: decoded.hostId,
      name: decoded.name,
      grantedPermissions,
      createdAtEpochMs: decoded.createdAtEpochMs,
      issuedByPrincipalId: decoded.issuedByPrincipalId,
      expiresAtEpochMs: Option.fromNullishOr(decoded.expiresAtEpochMs),
      revokedAtEpochMs: Option.fromNullishOr(decoded.revokedAtEpochMs),
      revokedByPrincipalId: Option.fromNullishOr(decoded.revokedByPrincipalId),
    }).pipe(
      Effect.mapError(() =>
        invariant(operation, "stored Host token lifecycle is invalid"),
      ),
    );
  });

const toInsertRow = (record: HostTokenRecord) => ({
  tokenId: record.tokenId,
  tokenHash: record.tokenHash,
  credentialVersion: record.credentialVersion,
  hostId: record.hostId,
  name: record.name,
  grantedPermissionsJson: encodeHostTokenPermissions(record.grantedPermissions),
  createdAtEpochMs: record.createdAtEpochMs,
  issuedByPrincipalId: record.issuedByPrincipalId,
  expiresAtEpochMs: Option.getOrNull(record.expiresAtEpochMs),
  revokedAtEpochMs: Option.getOrNull(record.revokedAtEpochMs),
  revokedByPrincipalId: Option.getOrNull(record.revokedByPrincipalId),
});

const invariant = (
  operation: "issue" | "verify" | "revoke" | "list",
  message: string,
) => new HostTokenInvariantViolation({ operation, message });

const mapStoreError =
  (operation: HostTokenRecordStoreOperation) =>
  <A, E extends { readonly _tag: string }, R>(
    effect: Effect.Effect<A, E | SqlError | EffectDrizzleQueryError, R>,
  ) => {
    const storeFailure = () =>
      Effect.fail(
        new HostTokenStoreError({
          operation,
          message: "Host token persistence operation failed",
        }),
      );
    const withoutSqlError = Effect.catchTag(effect, "SqlError", storeFailure);
    return Effect.catchTag(
      withoutSqlError,
      "EffectDrizzleQueryError",
      storeFailure,
    );
  };
