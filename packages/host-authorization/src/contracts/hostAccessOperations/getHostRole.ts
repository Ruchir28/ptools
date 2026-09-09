/**
 * Contract for `HostAccessStore.getHostRole`.
 *
 * Input: one stable application `roleId`, represented as a branded UUID string.
 * Success: the matching current `HostRole` domain value directly. Matching the
 * requested ID is an operation law enforced by every platform adapter.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostRoleNotFound,
} from "../hostAccessErrors.js";
import { HostRoleId } from "../hostRole.js";

/** Persisted role identity whose current definition is required. */
export class GetHostRoleInput extends Schema.Class<
  GetHostRoleInput,
  Brand.Brand<"GetHostRoleInput">
>("GetHostRoleInput")({ roleId: HostRoleId }) {}

/** Failures published by `HostAccessStore.getHostRole`. */
export type GetHostRoleError =
  | HostRoleNotFound
  | HostAccessInvariantViolation
  | HostAccessStoreError;
