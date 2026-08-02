/**
 * Contract for `HostAccessStore.listUserHosts`.
 *
 * Input: the user whose currently accessible hosts are requested.
 * Success: `ReadonlyArray<RegisteredHost>` directly, ordered by creation time and
 * then host ID. The array contains no duplicates or inaccessible hosts.
 *
 * Ordering, uniqueness, and user accessibility are operation laws exercised by
 * every platform's shared contract suite; they are not a second transport DTO.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";

/** Trusted store input identifying the user whose accessible hosts are listed. */
export class ListUserHostsInput extends Schema.Class<
  ListUserHostsInput,
  Brand.Brand<"ListUserHostsInput">
>("ListUserHostsInput")({ userId: Schema.NonEmptyString }) {}

/** Failures published by `HostAccessStore.listUserHosts`. */
export type ListUserHostsError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
