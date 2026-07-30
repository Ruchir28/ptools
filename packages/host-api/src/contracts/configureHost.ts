/**
 * Host configuration setup DTOs.
 *
 * This file owns the host-api operation for sending user-authored ptools config
 * to a host. The config object shape itself is owned by `@ptools/config`; this
 * file only wraps it in the host operation envelope and result union.
 */
import { UserPtoolsConfig } from "@ptools/config/contracts";
import { Schema } from "effect";

/** Structured configure input; raw JSON text is only a convenience outside the protocol. */
export const ConfigureHostInput = Schema.Struct({
  config: UserPtoolsConfig,
});
export type ConfigureHostInput = Schema.Schema.Type<typeof ConfigureHostInput>;

/** Host-api request envelope for configuring a host's ptools config. */
export const ConfigureHostRequest = Schema.Struct({
  operation: Schema.Literal("configure"),
  input: ConfigureHostInput,
});
export type ConfigureHostRequest = Schema.Schema.Type<
  typeof ConfigureHostRequest
>;

/** Operation-owned result for host config setup. */
export const ConfigureHostResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    configured: Schema.Literal(true),
    hostId: Schema.optional(Schema.String),
    serverCount: Schema.optional(Schema.Number),
    updatedAt: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.Literals([
        "invalid_config",
        "unsupported_config",
        "config_storage_unavailable",
      ]),
      message: Schema.String,
    }),
  }),
]);
export type ConfigureHostResult = Schema.Schema.Type<
  typeof ConfigureHostResult
>;

/** Response for a dispatched configure operation. */
export const ConfigureHostResponse = Schema.Struct({
  operation: Schema.Literal("configure"),
  result: ConfigureHostResult,
});
export type ConfigureHostResponse = Schema.Schema.Type<
  typeof ConfigureHostResponse
>;
