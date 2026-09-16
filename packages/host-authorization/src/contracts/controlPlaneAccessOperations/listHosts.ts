import { Brand, Schema } from "effect";
import { Pagination } from "../pagination.js";
import { RegisteredHostPagination } from "../registeredHostPagination.js";

/**
 * Caller-authored pagination for the Hosts visible to one admitted Principal.
 *
 * The input deliberately carries no Principal ID or visibility mode. The shared
 * `ControlPlaneAdministration` service adds the admitted identity and chooses
 * the Administrator-wide or Principal-scoped store operation.
 */
export class ListHostsInput extends Schema.Class<
  ListHostsInput,
  Brand.Brand<"ListHostsInput">
>("ListHostsInput")({
  limit: Pagination.PageSize,
  cursor: Schema.OptionFromOptionalKey(RegisteredHostPagination.Cursor),
}) {}
