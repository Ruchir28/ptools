export * as RegisteredHostPagination from "./registeredHostPagination.js";

import { Schema } from "effect";
import {
  cursorPayloadFilter,
  decodeCursorPayload,
  encodeCursorPayload,
} from "../paginationCursorCodec.js";

import { RegisteredHost } from "./registeredHost.js";

const CursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("registered-host"),
  hostId: Schema.NonEmptyString,
});

/**
 * Opaque Host-ID continuation token.
 *
 * Both global `listRegisteredHosts` and Principal-scoped `listPrincipalHosts`
 * traverse registered Hosts in unique ascending `hostId` order, using
 * `hostId` as the only keyset position. The cursor therefore carries no
 * creation timestamp: `createdAtEpochMs` remains a response field on each
 * `RegisteredHost` item but is not an ordering key, a seek predicate, or a
 * cursor component. Any platform store can resume traversal with
 * `WHERE hostId > :hostId`, and opaque relay keeps the token valid across
 * the HTTP boundary without exposing a row number or offset.
 */
export const Cursor = Schema.String.pipe(
  Schema.check(cursorPayloadFilter(CursorPayload)),
  Schema.brand("@ptools/RegisteredHostPagination.Cursor"),
);
export type Cursor = Schema.Schema.Type<typeof Cursor>;

/**
 * One bounded page of registered Hosts in ascending `hostId` order.
 *
 * Response items are complete `RegisteredHost` values, including
 * `createdAtEpochMs`; ordering and the continuation cursor use only the
 * unique `hostId` key. `nextCursor` continues strictly after the final
 * returned Host. Its absence means traversal reached the end; it is not a
 * row offset.
 */
export const Page = Schema.Struct({
  items: Schema.Array(RegisteredHost),
  nextCursor: Schema.OptionFromOptionalKey(Cursor),
}).annotate({ identifier: "RegisteredHostPagination.Page" });
export type Page = Schema.Schema.Type<typeof Page>;

/**
 * Creates a continuation cursor from the final published Host's unique ID.
 *
 * Callers pass only the ordering key (`hostId`), not the whole published
 * Host: creation time is display metadata on the item, never a seek key. The
 * cursor schema validates that the encoded Host ID is non-empty.
 */
export const makeCursor = (hostId: string): Cursor =>
  Cursor.make(
    encodeCursorPayload({ version: 1, kind: "registered-host", hostId }),
  );

/** Decodes a validated cursor into its database-neutral Host ordering key. */
export const decodeCursor = (cursor: Cursor) =>
  decodeCursorPayload(CursorPayload, cursor);
