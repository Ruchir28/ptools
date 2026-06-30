/**
 * Reusable schema contracts for Host HTTP route path and payload shapes.
 *
 * These schemas describe HTTP carrier data after route matching. The complete
 * HttpApi route table lives under `src/http/api`; these schemas live here so
 * shared handlers, adapters, clients, and platform packages can refer to the
 * same path/payload contracts without owning route declarations.
 */
import { Schema } from "effect";

export const HostPath = Schema.Struct({
  hostId: Schema.String,
});
export type HostPath = Schema.Schema.Type<typeof HostPath>;

export const HostMcpServerPath = Schema.Struct({
  hostId: Schema.String,
  serverName: Schema.String,
});
export type HostMcpServerPath = Schema.Schema.Type<typeof HostMcpServerPath>;

export const OAuthCallbackPath = Schema.Struct({
  hostId: Schema.String,
  provider: Schema.String,
});
export type OAuthCallbackPath = Schema.Schema.Type<typeof OAuthCallbackPath>;

export const EmptyHttpPayload = Schema.Struct({});
export type EmptyHttpPayload = Schema.Schema.Type<typeof EmptyHttpPayload>;

export const StartMcpAuthHttpPayload = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
});
export type StartMcpAuthHttpPayload = Schema.Schema.Type<
  typeof StartMcpAuthHttpPayload
>;
