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

export class HostHttpForbidden extends Schema.TaggedErrorClass<HostHttpForbidden>()(
  "HostHttpForbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class HostHttpNotFound extends Schema.TaggedErrorClass<HostHttpNotFound>()(
  "HostHttpNotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class HostHttpConflict extends Schema.TaggedErrorClass<HostHttpConflict>()(
  "HostHttpConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
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
