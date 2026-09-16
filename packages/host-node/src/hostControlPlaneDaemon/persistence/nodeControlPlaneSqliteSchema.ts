/**
 * @file Physical SQLite schema for one Node control-plane deployment.
 *
 * These Drizzle declarations are the source of truth for tables shared by the
 * Node-local identity implementation and the three authorization store
 * adapters. Table sharing does not transfer semantic write ownership: identity
 * writes only `local_identity` and `local_principal_credential`; each adapter
 * writes only the tables belonging to its shared store port.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Drizzle migrator history, named explicitly so deployment schema history is durable. */
export const schemaMigrationTable = sqliteTable("schema_migration", {
  id: integer("id").primaryKey(),
  hash: text("hash").notNull(),
  createdAt: integer("created_at"),
  name: text("name"),
  appliedAt: text("applied_at"),
});

/** Durable shared Principal identities; only ControlPlaneAccessStore may mutate it. */
export const principalTable = sqliteTable("principal", {
  principalId: text("principal_id").primaryKey(),
  createdAtEpochMs: integer("created_at_epoch_ms").notNull(),
});

/** Node-owned username/password verifier mapped to the fixed local Principal. */
export const localIdentityTable = sqliteTable(
  "local_identity",
  {
    identityId: integer("identity_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principalTable.principalId, { onDelete: "restrict" }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAtEpochMs: integer("created_at_epoch_ms").notNull(),
  },
  (table) => [
    uniqueIndex("local_identity_principal_unique").on(table.principalId),
    uniqueIndex("local_identity_username_unique").on(table.username),
  ],
);

/** Node-owned hash-only local API bearer mapped to the fixed local Principal. */
export const localPrincipalCredentialTable = sqliteTable(
  "local_principal_credential",
  {
    credentialId: integer("credential_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principalTable.principalId, { onDelete: "restrict" }),
    credentialVersion: integer("credential_version").notNull(),
    credentialHash: text("credential_hash").notNull(),
    createdAtEpochMs: integer("created_at_epoch_ms").notNull(),
  },
  (table) => [
    uniqueIndex("local_principal_credential_principal_unique").on(
      table.principalId,
    ),
    uniqueIndex("local_principal_credential_hash_unique").on(
      table.credentialHash,
    ),
    check(
      "local_principal_credential_version_v1",
      sql`${table.credentialVersion} = 1`,
    ),
  ],
);

/** Singleton initial-claim state; setup material is persisted only as a digest. */
export const controlPlaneClaimTable = sqliteTable(
  "control_plane_claim",
  {
    claimId: integer("claim_id").primaryKey(),
    setupCapabilityHash: text("setup_capability_hash"),
    initialAdministratorId: text("initial_administrator_id").references(
      () => principalTable.principalId,
      { onDelete: "restrict" },
    ),
    claimedAtEpochMs: integer("claimed_at_epoch_ms"),
  },
  (table) => [
    check("control_plane_claim_singleton", sql`${table.claimId} = 1`),
  ],
);

/**
 * Shared Control Plane role catalog persisted with stable package-owned IDs.
 *
 * Shared role IDs are canonical UUID strings, but SQLite has no native UUID
 * storage class. This Node schema deliberately stores their canonical textual
 * representation so persistence decoding can apply `ControlPlaneRoleId`
 * directly without a private bytes/string codec. This is not a recommendation
 * for databases with a real UUID type; those adapters should normally use it.
 * A future measured SQLite optimization could use a 16-byte BLOB, but it must
 * add one collision-safe RFC-ordered UUID codec at this persistence boundary.
 *
 * `primaryKey()` already creates SQLite's unique index for `role_id`; a second
 * one-column unique index would duplicate it.
 */
export const controlPlaneRoleTable = sqliteTable("control_plane_role", {
  roleId: text("role_id").primaryKey(),
  name: text("name").notNull(),
});

/**
 * Permission set belonging to one Control Plane role.
 *
 * Catalog order is package-owned derived data, not persisted state. Adapters
 * strictly decode each permission and canonicalize results using
 * `ControlPlanePermission.literals`; the composite primary key prevents a
 * duplicate permission without introducing a second position invariant.
 */
export const controlPlaneRolePermissionTable = sqliteTable(
  "control_plane_role_permission",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => controlPlaneRoleTable.roleId, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

/** Complete Principal-to-Control-Plane-role assignments. */
export const principalControlPlaneRoleTable = sqliteTable(
  "principal_control_plane_role",
  {
    principalId: text("principal_id")
      .notNull()
      .references(() => principalTable.principalId, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => controlPlaneRoleTable.roleId, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.roleId] }),
    // Last-Administrator checks address assignments by role rather than by the
    // composite primary key's leading Principal column.
    index("principal_control_plane_role_role_idx").on(table.roleId),
  ],
);

/**
 * Host identities registered for authorization before actor discovery.
 *
 * Global pages traverse in unique ascending `hostId` order and seek with
 * `WHERE hostId > :hostId`, which the `host_id` primary-key index serves
 * directly; no separate page index is needed. `createdAtEpochMs` is response
 * metadata on each published Host, never an ordering or cursor key. */
export const registeredHostTable = sqliteTable(
  "registered_host",
  {
    hostId: text("host_id").primaryKey(),
    createdAtEpochMs: integer("created_at_epoch_ms").notNull(),
  },
);

/**
 * Shared Host role catalog persisted with stable package-owned UUIDs.
 *
 * As above, `text` is a Node SQLite mapping rather than cross-platform storage
 * guidance: databases with native UUID columns should use them, while a SQLite
 * BLOB representation would require an explicit validated UUID codec. The
 * textual primary key already supplies the unique `role_id` index.
 */
export const hostRoleTable = sqliteTable("host_role", {
  roleId: text("role_id").primaryKey(),
  name: text("name").notNull(),
});

/**
 * Permission set belonging to one Host role.
 *
 * Adapters strictly decode the rows and derive deterministic output order from
 * `HostPermission.literals`. Persisting that catalog position would duplicate
 * package-owned information and create an unnecessary drift invariant.
 */
export const hostRolePermissionTable = sqliteTable(
  "host_role_permission",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => hostRoleTable.roleId, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

/**
 * Host membership existence, separate from its complete role selection.
 *
 * Principal-scoped Host pages drive from this table: they filter
 * `principalId` first, seek with `WHERE membership.hostId > :hostId`, and
 * join `registered_host` by its `hostId` primary key. The composite index
 * serves that ordered membership scan without touching the global Host
 * ordering; the `(hostId, principalId)` primary key alone cannot, because
 * its leading column is the wrong filter.
 */
export const principalHostMembershipTable = sqliteTable(
  "principal_host_membership",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => registeredHostTable.hostId, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principalTable.principalId, { onDelete: "cascade" }),
    createdAtEpochMs: integer("created_at_epoch_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hostId, table.principalId] }),
    index("principal_host_membership_principal_page_idx").on(
      table.principalId,
      table.hostId,
    ),
  ],
);

/** Complete role selection for one existing Principal Host membership. */
export const principalHostRoleTable = sqliteTable(
  "principal_host_role",
  {
    hostId: text("host_id").notNull(),
    principalId: text("principal_id").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => hostRoleTable.roleId, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.hostId, table.principalId, table.roleId] }),
    foreignKey({
      columns: [table.hostId, table.principalId],
      foreignColumns: [
        principalHostMembershipTable.hostId,
        principalHostMembershipTable.principalId,
      ],
    }).onDelete("cascade"),
  ],
);

/** Hash-only Host-token records owned exclusively by HostTokenRecordStore. */
export const hostTokenTable = sqliteTable(
  "host_token",
  {
    tokenId: text("token_id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => registeredHostTable.hostId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    grantedPermissionsJson: text("granted_permissions_json").notNull(),
    createdAtEpochMs: integer("created_at_epoch_ms").notNull(),
    issuedByPrincipalId: text("issued_by_principal_id")
      .notNull()
      .references(() => principalTable.principalId, { onDelete: "restrict" }),
    expiresAtEpochMs: integer("expires_at_epoch_ms"),
    revokedAtEpochMs: integer("revoked_at_epoch_ms"),
    revokedByPrincipalId: text("revoked_by_principal_id").references(
      () => principalTable.principalId,
      { onDelete: "restrict" },
    ),
  },
  (table) => [
    uniqueIndex("host_token_hash_unique").on(table.tokenHash),
    // Global and Host-scoped token pages both use indexed keyset traversal.
    index("host_token_page_idx").on(table.createdAtEpochMs, table.tokenId),
    index("host_token_host_page_idx").on(
      table.hostId,
      table.createdAtEpochMs,
      table.tokenId,
    ),
    check(
      "host_token_credential_version_v1",
      sql`${table.credentialVersion} = 1`,
    ),
    check(
      "host_token_revocation_pair",
      sql`(${table.revokedAtEpochMs} IS NULL AND ${table.revokedByPrincipalId} IS NULL) OR (${table.revokedAtEpochMs} IS NOT NULL AND ${table.revokedByPrincipalId} IS NOT NULL)`,
    ),
  ],
);

/** Applied shared role-catalog versions, independent of SQL migration history. */
export const authorizationCatalogStateTable = sqliteTable(
  "authorization_catalog_state",
  {
    catalogStateId: integer("catalog_state_id").primaryKey(),
    controlPlaneRoleVersion: integer("control_plane_role_version").notNull(),
    hostRoleVersion: integer("host_role_version").notNull(),
  },
  (table) => [
    check(
      "authorization_catalog_state_singleton",
      sql`${table.catalogStateId} = 1`,
    ),
  ],
);
