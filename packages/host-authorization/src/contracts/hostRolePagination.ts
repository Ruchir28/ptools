export * as HostRolePagination from "./hostRolePagination.js";

import { Schema } from "effect";
import {
  cursorPayloadFilter,
  decodeCursorPayload,
  encodeCursorPayload,
} from "../paginationCursorCodec.js";
import { HostRole, HostRoleId } from "./hostRole.js";

const CursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("host-role"),
  roleId: HostRoleId,
});

/** Opaque continuation token for Host-role catalog traversal. */
export const Cursor = Schema.String.pipe(
  Schema.check(cursorPayloadFilter(CursorPayload)),
  Schema.brand("@ptools/HostRolePagination.Cursor"),
);
export type Cursor = Schema.Schema.Type<typeof Cursor>;

/**
 * One bounded Host-role catalog page.
 *
 * `nextCursor` continues strictly after the final returned role. Its absence
 * means traversal reached the end of the catalog; it is not a row offset.
 */
export const Page = Schema.Struct({
  items: Schema.Array(HostRole),
  nextCursor: Schema.OptionFromOptionalKey(Cursor),
}).annotate({ identifier: "HostRolePagination.Page" });
export type Page = Schema.Schema.Type<typeof Page>;

/** Creates a continuation cursor from the final published role. */
export const makeCursor = (roleId: HostRoleId): Cursor =>
  Cursor.make(encodeCursorPayload({ version: 1, kind: "host-role", roleId }));

/** Decodes a validated cursor into its database-neutral role key. */
export const decodeCursor = (cursor: Cursor) =>
  decodeCursorPayload(CursorPayload, cursor);
