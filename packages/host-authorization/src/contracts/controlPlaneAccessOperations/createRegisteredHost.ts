import { Brand, Schema } from "effect";

/**
 * Caller-authored Host creation input. The trusted creator Principal is supplied
 * separately by admission, so public input cannot assign ownership to another
 * subject.
 */
export class CreateRegisteredHostInput extends Schema.Class<
  CreateRegisteredHostInput,
  Brand.Brand<"CreateRegisteredHostInput">
>("CreateRegisteredHostInput")({ requestedHostId: Schema.NonEmptyString }) {}
