/**
 * Contract for Administrator listing of every registered Host.
 * Results are ordered by creation time then Host ID and contain no duplicates.
 */
import { Brand, Schema } from "effect";
import type {
  HostAccessInvariantViolation,
  HostAccessStoreError,
} from "../hostAccessErrors.js";

export class ListRegisteredHostsInput extends Schema.Class<
  ListRegisteredHostsInput,
  Brand.Brand<"ListRegisteredHostsInput">
>("ListRegisteredHostsInput")({}) {}

export type ListRegisteredHostsError =
  | HostAccessInvariantViolation
  | HostAccessStoreError;
