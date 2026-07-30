/**
 * Effect service tag for callers that invoke Code Mode through Effect context.
 *
 * The service owns no transport by itself; platform packages provide a layer
 * that implements `call` over an in-process server, HTTP, Workers RPC, or the
 * shared host-api transport.
 */
import { Context, Effect } from "effect";
import type { CodeModeClientError } from "../codeModeErrors.js";
import type { CodeModeRequest, CodeModeResponse } from "../contracts/index.js";

/** Effect-native Code Mode client capability. */
export class CodeModeClient extends Context.Service<
  CodeModeClient,
  {
    /** Send one schema-backed Code Mode request. */
    readonly call: (
      request: CodeModeRequest,
    ) => Effect.Effect<CodeModeResponse, CodeModeClientError>;
  }
>()("@ptools/CodeModeClient") {}
