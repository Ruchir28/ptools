/**
 * Promise-based Code Mode client handle for non-Effect SDK callers.
 *
 * The handle is the default package's imperative boundary: transports and hosts
 * may implement it with HTTP, in-process calls, Workers RPC, or other carriers,
 * while Effect-native service tags live under `@ptools/code-mode-api/effect`.
 */
import type { CodeModeRequest, CodeModeResponse } from "./contracts/index.js";

/** Promise-facing Code Mode client used by SDK and agent-tools callers. */
export interface CodeModeClientHandle {
  /** Send one schema-backed Code Mode request and resolve with a success response. */
  readonly call: (request: CodeModeRequest) => Promise<CodeModeResponse>;

  /** Release any transport resources owned by this handle. */
  readonly close: () => Promise<void>;
}
