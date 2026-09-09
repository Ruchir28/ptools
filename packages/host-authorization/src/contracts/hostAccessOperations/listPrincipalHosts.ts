/**
 * Contract for `HostAccessStore.listPrincipalHosts`.
 *
 * Input: the Principal whose currently accessible Hosts are requested.
 * Success: `ReadonlyArray<RegisteredHost>` directly, ordered by creation time and
 * then host ID. The array contains no duplicates or inaccessible hosts.
 *
 * Ordering, uniqueness, and Principal accessibility are operation laws exercised by
 * every platform's shared contract suite; they are not a second transport DTO.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";
import { PrincipalId } from "../principal.js";

/** Trusted store input identifying the Principal whose Hosts are listed. */
export class ListPrincipalHostsInput extends Schema.Class<
  ListPrincipalHostsInput,
  Brand.Brand<"ListPrincipalHostsInput">
>("ListPrincipalHostsInput")({ principalId: PrincipalId }) {}

/** Failures published by `HostAccessStore.listPrincipalHosts`. */
export type ListPrincipalHostsError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
