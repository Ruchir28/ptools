/**
 * Contract for `HostAccessStore.listHostRoles`.
 *
 * Input: an explicit no-argument operation value. Success:
 * `ReadonlyArray<HostRole>` containing the complete current role catalog in
 * deterministic `roleKey` order. Platforms return persisted definitions rather
 * than comparing them with the original built-in constants.
 *
 * Completeness, uniqueness, and ordering are store laws verified against every
 * platform implementation.
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
