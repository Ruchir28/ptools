/** Promise-facing connect-only local deployment client conveniences. */
import type { CodeModeClientHandle } from "@ptools/code-mode-api";
import {
  connectLocalNodeHost,
  type ConnectLocalNodeHostOptions,
} from "./services/nodeLocalDeploymentRunner.js";

/** Connect to a running deployment and expose only its Code Mode capability. */
export const createNodeCodeModeClient = async (
  options: ConnectLocalNodeHostOptions,
): Promise<CodeModeClientHandle> =>
  (await connectLocalNodeHost(options)).codeMode;

export { connectLocalNodeHost };
export type { ConnectLocalNodeHostOptions };
