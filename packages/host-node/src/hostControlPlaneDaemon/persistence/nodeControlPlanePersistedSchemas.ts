/**
 * Runtime persistence decoders derived from the Node control-plane Drizzle
 * tables. Drizzle's inferred TypeScript models are not trusted as validation:
 * adapters decode query results through these schemas before publishing shared
 * domain values.
 */
import {
  ControlPlaneRoleId,
  EpochMillis,
  HostRoleId,
  HostTokenHash,
  HostTokenId,
  HostTokenName,
  PrincipalId,
} from "@ptools/host-authorization";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import {
  controlPlaneRoleTable,
  hostRoleTable,
  hostTokenTable,
  localIdentityTable,
  localPrincipalCredentialTable,
  principalTable,
  registeredHostTable,
} from "./nodeControlPlaneSqliteSchema.js";

/** Strict selected-row decoder for the shared Principal table. */
export const PrincipalRowSelectSchema = createSelectSchema(principalTable, {
  principalId: PrincipalId,
  createdAtEpochMs: EpochMillis,
});
/** Strict insertion decoder for the shared Principal table. */
export const PrincipalRowInsertSchema = createInsertSchema(principalTable, {
  principalId: PrincipalId,
  createdAtEpochMs: EpochMillis,
});
/** Strict update decoder; adapters should normally never update Principal identity. */
export const PrincipalRowUpdateSchema = createUpdateSchema(principalTable, {
  // Drizzle's refinement callback preserves update-field optionality; passing
  // either schema directly would incorrectly make that field required.
  principalId: () => PrincipalId,
  createdAtEpochMs: () => EpochMillis,
});

/** Strict selected-row decoder for Node-local password identity records. */
export const LocalIdentityRowSelectSchema = createSelectSchema(
  localIdentityTable,
  {
    principalId: PrincipalId,
    createdAtEpochMs: EpochMillis,
  },
);
/** Strict insertion decoder for Node-local password identity records. */
export const LocalIdentityRowInsertSchema = createInsertSchema(
  localIdentityTable,
  {
    principalId: PrincipalId,
    createdAtEpochMs: EpochMillis,
  },
);

const LocalApiBearerHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
);
/** Strict selected-row decoder for hash-only Node-local API credentials. */
export const LocalPrincipalCredentialRowSelectSchema = createSelectSchema(
  localPrincipalCredentialTable,
  {
    principalId: PrincipalId,
    credentialVersion: Schema.Literal(1),
    credentialHash: LocalApiBearerHash,
    createdAtEpochMs: EpochMillis,
  },
);
/** Strict insertion decoder for hash-only Node-local API credentials. */
export const LocalPrincipalCredentialRowInsertSchema = createInsertSchema(
  localPrincipalCredentialTable,
  {
    principalId: PrincipalId,
    credentialVersion: Schema.Literal(1),
    credentialHash: LocalApiBearerHash,
    createdAtEpochMs: EpochMillis,
  },
);

/** Strict selected-row decoder for registered Host identity and creation time. */
export const RegisteredHostRowSelectSchema = createSelectSchema(
  registeredHostTable,
  {
    hostId: Schema.NonEmptyString,
    createdAtEpochMs: EpochMillis,
  },
);
/** Strict insertion decoder for registered Host records. */
export const RegisteredHostRowInsertSchema = createInsertSchema(
  registeredHostTable,
  {
    hostId: Schema.NonEmptyString,
    createdAtEpochMs: EpochMillis,
  },
);

/** Strict selected-row decoder for stable Control Plane role IDs. */
export const ControlPlaneRoleRowSelectSchema = createSelectSchema(
  controlPlaneRoleTable,
  {
    roleId: ControlPlaneRoleId,
    name: Schema.NonEmptyString,
  },
);
/** Strict selected-row decoder for stable Host role IDs. */
export const HostRoleRowSelectSchema = createSelectSchema(hostRoleTable, {
  roleId: HostRoleId,
  name: Schema.NonEmptyString,
});

/** Strict selected-row decoder for hash-only Host-token persistence facts. */
export const HostTokenRowSelectSchema = createSelectSchema(hostTokenTable, {
  tokenId: HostTokenId,
  tokenHash: HostTokenHash,
  credentialVersion: Schema.Literal(1),
  hostId: Schema.NonEmptyString,
  name: HostTokenName,
  createdAtEpochMs: EpochMillis,
  issuedByPrincipalId: PrincipalId,
  expiresAtEpochMs: Schema.NullOr(EpochMillis),
  revokedAtEpochMs: Schema.NullOr(EpochMillis),
  revokedByPrincipalId: Schema.NullOr(PrincipalId),
});
