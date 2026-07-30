/**
 * Host operation DTOs for Code Mode.
 *
 * This file owns only the outer host-api wrapping for Code Mode calls. The
 * inner request/response schemas remain owned by `@ptools/code-mode-api`.
 */
import {
  CodeModeRequest,
  CodeModeResponse,
} from "@ptools/code-mode-api/contracts";
import { Schema } from "effect";

/** Host-api request envelope carrying one Code Mode request. */
export const HostCodeModeRequest = Schema.Struct({
  operation: Schema.Literal("code_mode"),
  input: CodeModeRequest,
});
export type HostCodeModeRequest = Schema.Schema.Type<
  typeof HostCodeModeRequest
>;

/** Operation-owned result for a dispatched Code Mode host operation. */
export const HostCodeModeResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    response: CodeModeResponse,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.Literals([
        "invalid_code_mode_request",
        "code_mode_server_failure",
      ]),
      message: Schema.String,
    }),
  }),
]);
export type HostCodeModeResult = Schema.Schema.Type<typeof HostCodeModeResult>;

/** Response for a dispatched code_mode operation. */
export const HostCodeModeResponse = Schema.Struct({
  operation: Schema.Literal("code_mode"),
  result: HostCodeModeResult,
});
export type HostCodeModeResponse = Schema.Schema.Type<
  typeof HostCodeModeResponse
>;
