/** Schema-backed HTTP errors returned by shared Host HTTP handlers. */
import { Schema } from "effect";

export class HostHttpBadRequest extends Schema.TaggedErrorClass<HostHttpBadRequest>()(
  "HostHttpBadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class HostHttpUnauthorized extends Schema.TaggedErrorClass<HostHttpUnauthorized>()(
  "HostHttpUnauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class HostHttpHostUnavailable extends Schema.TaggedErrorClass<HostHttpHostUnavailable>()(
  "HostHttpHostUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class HostHttpInternalError extends Schema.TaggedErrorClass<HostHttpInternalError>()(
  "HostHttpInternalError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export type HostHttpError =
  | HostHttpBadRequest
  | HostHttpUnauthorized
  | HostHttpHostUnavailable
  | HostHttpInternalError;
