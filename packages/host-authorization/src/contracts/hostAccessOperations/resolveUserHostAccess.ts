/**
 * Contract for `HostAccessStore.resolveUserHostAccess`.
 *
 * Input: one user/registered-host pair. Success: the matching `HostMemberAccess`
 * domain value directly. The platform resolves assigned roles, decodes and
 * unions their permissions, and returns canonical effective access.
 *
 * Returning access for the requested identities is an operation law. The
 * `HostMemberAccess` schema owns validity of the access value itself.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostMembershipNotFound,
  RegisteredHostNotFound,
} from "../hostAccessErrors.js";

/** User and registered host whose current effective access must be resolved. */
export class ResolveUserHostAccessInput extends Schema.Class<
  ResolveUserHostAccessInput,
  Brand.Brand<"ResolveUserHostAccessInput">
>("ResolveUserHostAccessInput")({
  hostId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
}) {}

/** Failures published by `HostAccessStore.resolveUserHostAccess`. */
export type ResolveUserHostAccessError =
  | RegisteredHostNotFound
  | HostMembershipNotFound
  | HostAccessInvariantViolation
  | HostAccessStoreError;
