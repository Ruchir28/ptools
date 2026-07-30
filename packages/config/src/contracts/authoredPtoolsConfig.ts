/**
 * User-authored ptools configuration contracts.
 *
 * This module owns the JSON-shaped config that humans write in files or apps.
 * Parsing normalizes this shape into `PtoolsConfig`; hosts may accept this DTO
 * at setup boundaries before storing or normalizing it.
 */
import { Schema } from "effect";
import {
  ExecutorConfig,
  StringRecord,
  UnresolvedHttpMcpAuthConfig,
} from "./configSchemaFields.js";

/** One user-authored MCP server entry before transport normalization. */
export const UserServerMcpConfig = Schema.Struct({
  command: Schema.OptionFromOptionalKey(Schema.String),
  args: Schema.OptionFromOptionalKey(Schema.Array(Schema.String)),
  cwd: Schema.OptionFromOptionalKey(Schema.String),
  env: Schema.OptionFromOptionalKey(StringRecord),
  url: Schema.OptionFromOptionalKey(Schema.String),
  headers: Schema.OptionFromOptionalKey(StringRecord),
  auth: Schema.OptionFromOptionalKey(UnresolvedHttpMcpAuthConfig),
  enabled: Schema.OptionFromOptionalKey(Schema.Boolean),
  disabled: Schema.OptionFromOptionalKey(Schema.Boolean),
});
export type UserServerMcpConfig = typeof UserServerMcpConfig.Type;

/**
 * JSON-shaped ptools config users author in files or setup APIs.
 *
 * Users select server transport by providing `command` or `url` and may disable
 * entries. Optional JSON fields decode into `Option` values so normalization can
 * stay explicit and fail-fast.
 */
export const UserPtoolsConfig = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, UserServerMcpConfig),
  executor: Schema.OptionFromOptionalKey(ExecutorConfig),
});
export type UserPtoolsConfig = typeof UserPtoolsConfig.Type;
