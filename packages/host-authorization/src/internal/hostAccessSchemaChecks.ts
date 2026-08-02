/**
 * Shared predicates used by Schema filters on host-access contracts.
 *
 * These do not read storage. They run only when a branded schema constructs or
 * decodes a value (`.make`, `.makeEffect`, `decodeUnknown`).
 *
 * Application logic, RPC equality, and tests depend on canonical orders below.
 * Platforms must satisfy those orders on every successful shared value. Prefer
 * physical storage/indexes that already match (so queries return ordered data);
 * sorting in memory between load and construction is allowed but secondary.
 * Filters never auto-sort — uncanonical input fails construction.
 */
import { HostPermission } from "../contracts/hostPermission.js";

const permissionOrder = new Map(
  HostPermission.literals.map((permission, index) => [permission, index]),
);

/**
 * True when permissions are unique and follow the package catalog order
 * (`HostPermission.literals` index), not alphabetical order.
 *
 * Prefer persisting or materializing permission sets in that same catalog order
 * so membership resolution can union and return without an extra sort.
 */
export const hasUniqueCanonicalPermissions = (
  permissions: ReadonlyArray<HostPermission>,
): boolean => {
  let previousIndex = -1;
  const seen = new Set<HostPermission>();

  for (const permission of permissions) {
    const index = permissionOrder.get(permission);
    if (index === undefined || seen.has(permission) || index <= previousIndex) {
      return false;
    }
    seen.add(permission);
    previousIndex = index;
  }

  return true;
};

/** True when a role-key selection contains no duplicate key. */
export const hasUniqueValues = <A>(values: ReadonlyArray<A>): boolean =>
  new Set(values).size === values.length;
