/**
 * Contract for `HostAccessStore.getHostRole`.
 *
 * Input: one stable application `roleKey`. Success: the matching current
 * `HostRole` domain value directly. A platform may join several physical rows,
 * but it decodes one complete role before crossing this boundary.
 *
 * Matching the requested key is an operation law; `HostRole` owns intrinsic
 * role validity independently of any particular lookup.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  HostRoleNotFound,
} from "../hostAccessErrors.js";
import { HostRoleKey } from "../hostRole.js";

/** Stable application role key whose current definition is required. */
export class GetHostRoleInput extends Schema.Class<
  GetHostRoleInput,
  Brand.Brand<"GetHostRoleInput">
>("GetHostRoleInput")({ roleKey: HostRoleKey }) {}

/** Failures published by `HostAccessStore.getHostRole`. */
export type GetHostRoleError =
  | HostRoleNotFound
  | HostAccessInvariantViolation
  | HostAccessStoreError;
