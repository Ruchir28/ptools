export * as HostTokenPagination from "./hostTokenPagination.js";

import { Schema } from "effect";
import {
  cursorPayloadFilter,
  decodeCursorPayload,
  encodeCursorPayload,
} from "../paginationCursorCodec.js";
import { EpochMillis, HostToken, HostTokenRecord } from "./hostToken.js";
import { HostTokenId } from "./hostTokenIdentity.js";

const CursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("host-token"),
  createdAtEpochMs: EpochMillis,
  tokenId: HostTokenId,
});

/** Opaque creation-time/token-ID continuation token. */
export const Cursor = Schema.String.pipe(
  Schema.check(cursorPayloadFilter(CursorPayload)),
  Schema.brand("@ptools/HostTokenPagination.Cursor"),
);
export type Cursor = Schema.Schema.Type<typeof Cursor>;

/**
 * Hash-only persistence page returned by `HostTokenRecordStore`.
 *
 * Platform adapters create it after strict row decoding. It may carry token
 * digests inside `items`, so only the shared `HostTokenService` consumes it;
 * HTTP and SDK callers receive the disclosure-safe companion page below.
 */
export const RecordPage = Schema.Struct({
  items: Schema.Array(HostTokenRecord),
  nextCursor: Schema.OptionFromOptionalKey(Cursor),
}).annotate({ identifier: "HostTokenPagination.RecordPage" });
export type RecordPage = Schema.Schema.Type<typeof RecordPage>;

/**
 * Disclosure-safe Host-token page returned to management callers.
 *
 * `HostTokenService` constructs it by removing each persistence digest while
 * preserving ordering and the opaque continuation cursor. It can cross HTTP or
 * SDK boundaries and structurally cannot disclose bearer plaintext or hashes.
 */
export const Page = Schema.Struct({
  items: Schema.Array(HostToken),
  nextCursor: Schema.OptionFromOptionalKey(Cursor),
}).annotate({ identifier: "HostTokenPagination.Page" });
export type Page = Schema.Schema.Type<typeof Page>;

/** Creates a continuation cursor from the final published token. */
export const makeCursor = (input: {
  readonly createdAtEpochMs: number;
  readonly tokenId: HostTokenId;
}): Cursor =>
  Cursor.make(
    encodeCursorPayload({ version: 1, kind: "host-token", ...input }),
  );

/** Decodes a validated cursor into database-neutral token ordering keys. */
export const decodeCursor = (cursor: Cursor) =>
  decodeCursorPayload(CursorPayload, cursor);
