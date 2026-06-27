/**
 * Promise-based host client handle for SDK users.
 *
 * This file owns the default package surface shape for non-Effect callers. The
 * implementation is provided by platform packages, usually by wrapping an
 * internal Effect runtime/layer graph.
 */
import type { CodeModeClientHandle } from "@ptools/code-mode-api";
import type {
  HostApiRequest,
  HostApiResponse,
} from "./contracts/hostApiEnvelope.js";

/** Promise SDK host handle that can call host operations and expose Code Mode. */
export interface HostClientHandle {
  /** Low-level escape hatch for any host-api operation. */
  readonly call: (request: HostApiRequest) => Promise<HostApiResponse>;

  /** Focused Code Mode capability derived from the same host connection. */
  readonly codeMode: CodeModeClientHandle;

  /** Release platform resources held by the client runtime. */
  readonly close: () => Promise<void>;
}
