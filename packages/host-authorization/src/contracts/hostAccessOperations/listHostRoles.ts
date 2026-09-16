/**
 * Contract for `HostAccessStore.listHostRoles`.
 *
 * Input selects one bounded keyset page. Success contains complete role values
 * for that page, including every permission of each returned role. Every
 * platform orders by unique logical role UUID and continues strictly after the
 * cursor; IDs provide traversal order only, not hierarchy or built-in status.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";
import { HostRolePagination } from "../hostRolePagination.js";
import { Pagination } from "../pagination.js";

/** Bounded keyset request for the current Host-role catalog. */
export class ListHostRolesInput extends Schema.Class<
  ListHostRolesInput,
  Brand.Brand<"ListHostRolesInput">
>("ListHostRolesInput")({
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(HostRolePagination.Cursor),
}) {}

/** Failures published by `HostAccessStore.listHostRoles`. */
export type ListHostRolesError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
