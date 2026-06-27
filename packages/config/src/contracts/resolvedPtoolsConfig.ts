/**
 * Resolved ptools configuration contracts.
 *
 * This module owns config domain values after all env/secret placeholders have
 * been resolved. These values are safe for runtime MCP/auth/executor consumers
 * and can be schema-encoded when crossing serialization boundaries.
 */
import { Schema } from "effect";
import { StringRecord } from "./configSchemaFields.js";

/** Resolved executor settings consumed by runtime execution services. */
export class ResolvedExecutorConfig extends Schema.Class<ResolvedExecutorConfig>(
  "ResolvedExecutorConfig",
)({
  defaultTimeoutMs: Schema.optionalWith(Schema.Number, {
    exact: true,
    as: "Option",
  }),
}) {
  declare private readonly _resolvedExecutorConfigBrand: void;
}

/** Resolved OAuth settings for an HTTP MCP server. */
export class ResolvedHttpMcpAuthConfig extends Schema.Class<ResolvedHttpMcpAuthConfig>(
  "ResolvedHttpMcpAuthConfig",
)({
  type: Schema.Literal("oauth"),
  scope: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  resourceMetadataUrl: Schema.optionalWith(Schema.String, {
    exact: true,
    as: "Option",
  }),
  clientId: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  clientSecret: Schema.optionalWith(Schema.String, {
    exact: true,
    as: "Option",
  }),
  clientMetadataUrl: Schema.optionalWith(Schema.String, {
    exact: true,
    as: "Option",
  }),
  redirectUri: Schema.optionalWith(Schema.String, {
    exact: true,
    as: "Option",
  }),
}) {
  declare private readonly _resolvedHttpMcpAuthConfigBrand: void;
}

/** Resolved stdio MCP server config. */
export class ResolvedStdioMcpConfig extends Schema.Class<ResolvedStdioMcpConfig>(
  "ResolvedStdioMcpConfig",
)({
  transport: Schema.Literal("stdio").pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "stdio"),
  ),
  command: Schema.String,
  args: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
    as: "Option",
  }),
  env: Schema.optionalWith(StringRecord, { exact: true, as: "Option" }),
  cwd: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
}) {
  declare private readonly _resolvedStdioMcpConfigBrand: void;
}

/** Resolved streamable HTTP MCP server config. */
export class ResolvedHttpMcpConfig extends Schema.Class<ResolvedHttpMcpConfig>(
  "ResolvedHttpMcpConfig",
)({
  transport: Schema.Literal("http").pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "http"),
  ),
  url: Schema.String,
  headers: Schema.optionalWith(StringRecord, { exact: true, as: "Option" }),
  auth: Schema.optionalWith(ResolvedHttpMcpAuthConfig, {
    exact: true,
    as: "Option",
  }),
}) {
  declare private readonly _resolvedHttpMcpConfigBrand: void;
}

/** Any resolved MCP server config. */
export type ResolvedMcpConfig = ResolvedStdioMcpConfig | ResolvedHttpMcpConfig;

/** Map of resolved MCP server names to configs. */
export type ResolvedMcpServers = Readonly<Record<string, ResolvedMcpConfig>>;

/** Fully resolved ptools config loaded by host runtimes. */
export class ResolvedPtoolsConfig extends Schema.Class<ResolvedPtoolsConfig>(
  "ResolvedPtoolsConfig",
)({
  mcpServers: Schema.Record({
    key: Schema.String,
    value: Schema.Union(ResolvedStdioMcpConfig, ResolvedHttpMcpConfig),
  }),
  executor: Schema.optionalWith(ResolvedExecutorConfig, {
    exact: true,
    as: "Option",
  }),
}) {
  declare private readonly _resolvedPtoolsConfigBrand: void;
}
