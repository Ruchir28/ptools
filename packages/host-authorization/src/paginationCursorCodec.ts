/**
 * Codec for keyset-pagination continuation cursors.
 *
 * A cursor is an opaque token that leaves the server, lives with a client, and
 * comes back on a later request. The lifecycle:
 *
 * ```txt
 * mint:    payload object -> JSON -> base64url string -> branded Cursor
 * client:  holds the string, treats it as opaque
 * return:  string -> base64url decode -> JSON parse -> payload schema check
 * ```
 *
 * Each operation's contract (e.g. `contracts/hostRolePagination.ts`) owns its
 * payload schema and brands a `Cursor` with `cursorPayloadFilter`, so invalid
 * cursors are rejected at the request boundary. This module supplies the
 * shared serialization pieces those contracts compose.
 */
import { Encoding, Result, Schema } from "effect";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const parseCursor = (cursor: string): unknown => {
  const decoded = Encoding.decodeBase64Url(cursor);
  if (Result.isFailure(decoded)) return undefined;
  try {
    return JSON.parse(utf8Decoder.decode(decoded.success));
  } catch {
    return undefined;
  }
};

/**
 * Creates a schema check proving that an opaque cursor carries one payload.
 *
 * A cursor is not an internal value: it is handed to a client as an opaque
 * string, stored there, and replayed on a later request, so it crosses an
 * untrusted boundary twice. Attaching this filter to the string schema means
 * the cursor is fully validated (base64url decodable, JSON, and matching the
 * operation-specific payload shape) at the request boundary where it first
 * arrives, before it can reach a store. The branded `Cursor` types built on
 * this filter (see `contracts/*Pagination.ts`) then guarantee that anything
 * typed as a cursor has already passed it, which is what
 * `decodeCursorPayload` relies on.
 */
export const cursorPayloadFilter = <
  S extends Schema.ConstraintDecoder<unknown, never>,
>(
  schema: S,
) =>
  Schema.makeFilter(
    (cursor: string) => Schema.is(schema)(parseCursor(cursor)),
    {
      expected: "an opaque supported keyset-pagination cursor",
    },
  );

/**
 * Encodes database-neutral ordering keys for relay through transport APIs.
 *
 * Keyset pagination resumes with `WHERE key > last-seen`, so the last sort key
 * must survive a round trip through the client. It is serialized to JSON and
 * then base64url-encoded rather than sent raw because the cursor ends up in
 * query strings: raw JSON contains quotes, braces, and commas that break or
 * get mangled by URL transport, while base64url is URL-safe by alphabet.
 *
 * The encoding also keeps the token opaque. Clients must treat the cursor as
 * an opaque string so the payload format can change without breaking them;
 * the `version` and `kind` fields each payload carries are what make those
 * changes and cross-endpoint replay detectable (each operation's schema
 * accepts only its own `kind` literal and rejects unknown `version` values
 * instead of decoding them into garbage keys).
 */
export const encodeCursorPayload = (payload: object): string =>
  Encoding.encodeBase64Url(utf8Encoder.encode(JSON.stringify(payload)));

/**
 * Decodes a cursor already validated by its operation-specific cursor schema.
 *
 * This is the return trip of `encodeCursorPayload`: the string that comes back
 * cannot be trusted, because a client may have mutated it, replayed a cursor
 * minted by a different endpoint, or sent one from before a format change.
 * Callers therefore pass the operation's own payload schema, and a mismatch
 * fails loudly here rather than restarting traversal from the beginning, which
 * would silently return overlapping pages.
 *
 * "Already validated" means the caller received a branded `Cursor` decoded
 * through `cursorPayloadFilter`, which proves the string is base64url + JSON
 * with the right payload shape before this function parses it again.
 */
export const decodeCursorPayload = <
  S extends Schema.ConstraintDecoder<unknown, never>,
>(
  schema: S,
  cursor: string,
): S["Type"] => Schema.decodeUnknownSync(schema)(parseCursor(cursor));
