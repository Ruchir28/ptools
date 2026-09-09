import { v5 as uuidV5 } from "uuid";

/**
 * Permanent UUIDv5 namespace for package-owned authorization roles.
 *
 * This value is identity material, not a release or catalog version. Changing
 * it would assign every built-in role a different identity and orphan existing
 * assignments, so it must remain stable for the lifetime of those roles.
 * Platforms consume the derived role IDs from the built-in catalogs rather
 * than independently reproducing this derivation.
 */
export const BuiltInRoleUuidNamespace = "60990dc7-4e29-4f38-9901-4a522c7a1c45";

/**
 * Derives one package-owned role UUID from its permanent canonical name.
 *
 * Canonical names include the catalog boundary, for example `host/owner` or
 * `control-plane/administrator`, so equal labels in different catalogs cannot
 * collide. These names are immutable identity inputs and are deliberately
 * separate from renameable role display names.
 */
export const deriveBuiltInRoleId = (canonicalName: string): string =>
  uuidV5(canonicalName, BuiltInRoleUuidNamespace);
