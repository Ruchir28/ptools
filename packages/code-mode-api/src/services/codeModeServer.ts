/**
 * Effect service tag for a host-owned Code Mode server implementation.
 *
 * The server receives already-decoded Code Mode requests and delegates to the
 * MCP-first Code Mode runtime. Platform entrypoints adapt their carrier into
 * this service instead of embedding transport behavior here.
 */
import { Context, Effect } from "effect";
import type { CodeModeServerError } from "../codeModeErrors.js";
import type { CodeModeRequest, CodeModeResponse } from "../contracts/index.js";

/** Effect-native Code Mode server capability provided by host runtimes. */
export class CodeModeServer extends Context.Service<
  CodeModeServer,
  {
    /** Handle one schema-backed Code Mode request. */
    readonly handle: (
      request: CodeModeRequest,
    ) => Effect.Effect<CodeModeResponse, CodeModeServerError>;
  }
>()("@ptools/CodeModeServer") {}
