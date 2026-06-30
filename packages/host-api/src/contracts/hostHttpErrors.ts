/** Schema-backed HTTP errors returned by shared Host HTTP handlers. */
import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

export class HostHttpBadRequest extends Schema.TaggedError<HostHttpBadRequest>()(
  "HostHttpBadRequest",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class HostHttpUnauthorized extends Schema.TaggedError<HostHttpUnauthorized>()(
  "HostHttpUnauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class HostHttpHostUnavailable extends Schema.TaggedError<HostHttpHostUnavailable>()(
  "HostHttpHostUnavailable",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class HostHttpInternalError extends Schema.TaggedError<HostHttpInternalError>()(
  "HostHttpInternalError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export type HostHttpError =
  | HostHttpBadRequest
  | HostHttpUnauthorized
  | HostHttpHostUnavailable
  | HostHttpInternalError;
