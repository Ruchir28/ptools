/**
 * Contract for `HostAccessStore.listPrincipalHosts`.
 *
 * Input: the Principal whose currently accessible Hosts are requested plus a
 * bounded keyset position. Success is one `RegisteredHostPage` in unique
 * ascending `hostId` order, with no duplicates or inaccessible Hosts.
 * Response items remain complete `RegisteredHost` values: `createdAtEpochMs`
 * is published on each item but is not an ordering or cursor key.
 *
 * Ordering, uniqueness, and Principal accessibility are operation laws exercised by
 * every platform's shared contract suite; they are not a second transport DTO.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";
import { Pagination } from "../pagination.js";
import { RegisteredHostPagination } from "../registeredHostPagination.js";
import { PrincipalId } from "../principal.js";

/**
 * Trusted store input identifying the Principal whose Hosts are listed.
 *
 * The owning `HostAccessStore` drives from `principal_host_membership`
 * filtered by `principalId`, seeks with `WHERE membership.hostId > :hostId`,
 * and joins `registered_host` by its `hostId` primary key.
 */
export class ListPrincipalHostsInput extends Schema.Class<
  ListPrincipalHostsInput,
  Brand.Brand<"ListPrincipalHostsInput">
>("ListPrincipalHostsInput")({
  principalId: PrincipalId,
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(RegisteredHostPagination.Cursor),
}) {}

/** Failures published by `HostAccessStore.listPrincipalHosts`. */
export type ListPrincipalHostsError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
