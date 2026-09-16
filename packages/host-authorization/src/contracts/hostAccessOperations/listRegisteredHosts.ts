/**
 * Contract for Administrator traversal of registered Hosts in bounded pages.
 * Results use unique ascending `hostId` keyset order and contain no duplicates.
 * Response items remain complete `RegisteredHost` values: `createdAtEpochMs`
 * is published on each item but is not an ordering or cursor key.
 */
import { Brand, Schema } from "effect";
import type {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";
import { Pagination } from "../pagination.js";
import { RegisteredHostPagination } from "../registeredHostPagination.js";

/**
 * Trusted store request for an Administrator-visible Host page.
 *
 * The owning `HostAccessStore` resumes with `WHERE hostId > :hostId` using
 * the opaque `RegisteredHostPagination.Cursor`; `createdAtEpochMs` never
 * participates in ordering or seeking.
 */
export class ListRegisteredHostsInput extends Schema.Class<
  ListRegisteredHostsInput,
  Brand.Brand<"ListRegisteredHostsInput">
>("ListRegisteredHostsInput")({
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(RegisteredHostPagination.Cursor),
}) {}

export type ListRegisteredHostsError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
