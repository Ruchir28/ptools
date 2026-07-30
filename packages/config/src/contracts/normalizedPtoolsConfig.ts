/**
 * Normalized ptools configuration contracts.
 *
 * This module owns the validated config shape used after user-authored config is
 * parsed but before secret placeholders are resolved. Servers have explicit
 * transport discriminators and disabled authored entries are removed.
 */
import { Schema } from "effect";
import {
  ExecutorConfig,
  StringRecord,
  UnresolvedHttpMcpAuthConfig,
} from "./configSchemaFields.js";

/** Normalized MCP server config before env/secret placeholders resolve. */
export const ServerMcpConfig = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.OptionFromOptionalKey(Schema.Array(Schema.String)),
    cwd: Schema.OptionFromOptionalKey(Schema.String),
    env: Schema.OptionFromOptionalKey(StringRecord),
  }),
  Schema.Struct({
    transport: Schema.Literal("http"),
    url: Schema.String,
    headers: Schema.OptionFromOptionalKey(StringRecord),
    auth: Schema.OptionFromOptionalKey(UnresolvedHttpMcpAuthConfig),
  }),
]);
export type ServerMcpConfig = typeof ServerMcpConfig.Type;

/**
 * Validated, normalized config used internally before secrets are resolved.
 *
 * Unlike `UserPtoolsConfig`, this domain value contains explicit transport
 * discriminators and does not contain disabled servers. Optional domain values
 * remain `Option`s until resolution crosses into external contracts.
 */
export class PtoolsConfig extends Schema.Class<PtoolsConfig>("PtoolsConfig")({
  mcpServers: Schema.Record(Schema.String, ServerMcpConfig),
  executor: Schema.OptionFromOptionalKey(ExecutorConfig),
}) {
  declare private readonly _ptoolsConfigBrand: void;
}
