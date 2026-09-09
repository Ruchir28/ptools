/**
 * Contract for `HostAccessStore.listHostRoles`.
 *
 * Input: an explicit no-argument operation value. Success contains the complete
 * current persisted role catalog. Every platform returns unique logical role
 * UUIDs; IDs carry no presentation-order meaning, so callers must not infer
 * hierarchy or built-in status from array order.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";

/** Explicit no-argument input for listing the current role catalog. */
export class ListHostRolesInput extends Schema.Class<
  ListHostRolesInput,
  Brand.Brand<"ListHostRolesInput">
>("ListHostRolesInput")({}) {}

/** Failures published by `HostAccessStore.listHostRoles`. */
export type ListHostRolesError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
