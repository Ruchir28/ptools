import { Brand, Schema } from "effect";

/**
 * Application projection of one host registered in the central access catalog.
 *
 * This is neither an active host runtime nor a promise about a database row
 * shape. A platform may store surrogate IDs and additional columns privately,
 * then decode only this shared host identity and creation metadata.
 *
 * Branding makes the value nominal: plain `{ hostId, createdAtEpochMs }`
 * objects are not assignable. `createdAtEpochMs` comes from the trusted platform
 * clock when registration succeeds, never from untrusted HTTP input.
 */
export class RegisteredHost extends Schema.Class<
  RegisteredHost,
  Brand.Brand<"RegisteredHost">
>("RegisteredHost")({
  hostId: Schema.NonEmptyString,
  createdAtEpochMs: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
}) {}
