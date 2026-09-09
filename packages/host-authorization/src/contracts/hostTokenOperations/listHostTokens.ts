import { Brand, Schema } from "effect";
import type { HostToken } from "../hostToken.js";
import type {
  HostTokenInvariantViolation,
  HostTokenStoreError,
} from "../hostTokenErrors.js";

/** Host-scoped safe token inventory requested after Host admission. */
export class ListHostTokensInput extends Schema.Class<
  ListHostTokensInput,
  Brand.Brand<"ListHostTokensInput">
>("ListHostTokensInput")({ hostId: Schema.NonEmptyString }) {}

/** Administrator-only cross-Host safe token inventory. */
export class ListAllHostTokensInput extends Schema.Class<
  ListAllHostTokensInput,
  Brand.Brand<"ListAllHostTokensInput">
>("ListAllHostTokensInput")({}) {}

export type ListHostTokensError =
  | HostTokenInvariantViolation
  | HostTokenStoreError;
export type ListHostTokensSuccess = ReadonlyArray<HostToken>;
