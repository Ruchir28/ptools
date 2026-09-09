/**
 * Contract for `HostAccessStore.resolvePrincipalHostAccess`.
 *
 * Input: one Principal/registered-Host pair. Success: matching access
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
import { PrincipalId } from "../principal.js";

/** Principal and registered Host whose current access must be resolved. */
export class ResolvePrincipalHostAccessInput extends Schema.Class<
  ResolvePrincipalHostAccessInput,
  Brand.Brand<"ResolvePrincipalHostAccessInput">
>("ResolvePrincipalHostAccessInput")({
  hostId: Schema.NonEmptyString,
  principalId: PrincipalId,
}) {}

/** Failures published by `HostAccessStore.resolvePrincipalHostAccess`. */
export type ResolvePrincipalHostAccessError =
  | RegisteredHostNotFound
  | HostMembershipNotFound
  | HostAccessInvariantViolation
  | HostAccessStoreError;
