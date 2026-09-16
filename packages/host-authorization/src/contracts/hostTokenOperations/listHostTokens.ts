import { Brand, Schema } from "effect";
import { HostTokenPagination } from "../hostTokenPagination.js";
import type {
  HostTokenInvariantViolation,
  HostTokenStoreError,
} from "../hostTokenErrors.js";
import { Pagination } from "../pagination.js";

/** Caller-authored token pagination without a caller-controlled Host scope. */
export class HostTokenPageRequest extends Schema.Class<
  HostTokenPageRequest,
  Brand.Brand<"HostTokenPageRequest">
>("HostTokenPageRequest")({
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(HostTokenPagination.Cursor),
}) {}

/** Host-scoped safe token inventory requested after Host admission. */
export class ListHostTokensInput extends Schema.Class<
  ListHostTokensInput,
  Brand.Brand<"ListHostTokensInput">
>("ListHostTokensInput")({
  hostId: Schema.NonEmptyString,
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(HostTokenPagination.Cursor),
}) {}

/** Administrator-only bounded cross-Host token inventory request. */
export class ListAllHostTokensInput extends Schema.Class<
  ListAllHostTokensInput,
  Brand.Brand<"ListAllHostTokensInput">
>("ListAllHostTokensInput")({
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(HostTokenPagination.Cursor),
}) {}

export type ListHostTokensError =
  | HostTokenInvariantViolation
  | HostTokenStoreError;
export type ListHostTokensSuccess = HostTokenPagination.Page;
