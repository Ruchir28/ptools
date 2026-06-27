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
  command: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  args: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
    as: "Option",
  }),
  cwd: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  env: Schema.optionalWith(StringRecord, { exact: true, as: "Option" }),
  url: Schema.optionalWith(Schema.String, { exact: true, as: "Option" }),
  headers: Schema.optionalWith(StringRecord, { exact: true, as: "Option" }),
  auth: Schema.optionalWith(UnresolvedHttpMcpAuthConfig, {
    exact: true,
    as: "Option",
  }),
  enabled: Schema.optionalWith(Schema.Boolean, { exact: true, as: "Option" }),
  disabled: Schema.optionalWith(Schema.Boolean, { exact: true, as: "Option" }),
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
  mcpServers: Schema.Record({
    key: Schema.String,
    value: UserServerMcpConfig,
  }),
  executor: Schema.optionalWith(ExecutorConfig, { exact: true, as: "Option" }),
});
export type UserPtoolsConfig = typeof UserPtoolsConfig.Type;
