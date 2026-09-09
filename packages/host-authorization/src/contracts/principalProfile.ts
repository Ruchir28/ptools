import { Schema } from "effect";
import { PrincipalId } from "./principal.js";

/** Provider-owned presentation metadata; none of these fields grants access. */
export class PrincipalProfile extends Schema.Class<PrincipalProfile>(
  "PrincipalProfile",
)({
  principalId: PrincipalId,
  displayName: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  email: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  avatarUrl: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
}) {}

/** Safe failure for an unavailable or malfunctioning profile provider. */
export class PrincipalDirectoryError extends Schema.TaggedErrorClass<PrincipalDirectoryError>()(
  "PrincipalDirectoryError",
  { message: Schema.NonEmptyString },
) {}
