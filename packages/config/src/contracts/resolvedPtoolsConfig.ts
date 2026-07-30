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
  defaultTimeoutMs: Schema.OptionFromOptionalKey(Schema.Number),
}) {
  declare private readonly _resolvedExecutorConfigBrand: void;
}

/** Resolved OAuth settings for an HTTP MCP server. */
export class ResolvedHttpMcpAuthConfig extends Schema.Class<ResolvedHttpMcpAuthConfig>(
  "ResolvedHttpMcpAuthConfig",
)({
  type: Schema.Literal("oauth"),
  scope: Schema.OptionFromOptionalKey(Schema.String),
  resourceMetadataUrl: Schema.OptionFromOptionalKey(Schema.String),
  clientId: Schema.OptionFromOptionalKey(Schema.String),
  clientSecret: Schema.OptionFromOptionalKey(Schema.String),
  clientMetadataUrl: Schema.OptionFromOptionalKey(Schema.String),
  redirectUri: Schema.OptionFromOptionalKey(Schema.String),
}) {
  declare private readonly _resolvedHttpMcpAuthConfigBrand: void;
}

/** Resolved stdio MCP server config. */
export class ResolvedStdioMcpConfig extends Schema.Class<ResolvedStdioMcpConfig>(
  "ResolvedStdioMcpConfig",
)({
  transport: Schema.tag("stdio"),
  command: Schema.String,
  args: Schema.OptionFromOptionalKey(Schema.Array(Schema.String)),
  env: Schema.OptionFromOptionalKey(StringRecord),
  cwd: Schema.OptionFromOptionalKey(Schema.String),
}) {
  declare private readonly _resolvedStdioMcpConfigBrand: void;
}

/** Resolved streamable HTTP MCP server config. */
export class ResolvedHttpMcpConfig extends Schema.Class<ResolvedHttpMcpConfig>(
  "ResolvedHttpMcpConfig",
)({
  transport: Schema.tag("http"),
  url: Schema.String,
  headers: Schema.OptionFromOptionalKey(StringRecord),
  auth: Schema.OptionFromOptionalKey(ResolvedHttpMcpAuthConfig),
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
  mcpServers: Schema.Record(
    Schema.String,
    Schema.Union([ResolvedStdioMcpConfig, ResolvedHttpMcpConfig]),
  ),
  executor: Schema.OptionFromOptionalKey(ResolvedExecutorConfig),
}) {
  declare private readonly _resolvedPtoolsConfigBrand: void;
}
