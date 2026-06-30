/**
 * @file Cloudflare compatibility export for the host-neutral CodeModeServer
 * adapter.
 *
 * Cloudflare-specific code owns Worker/Durable Object transport and runtime
 * assembly. The actual CodeModeRequest -> CodeMode dispatch is shared by
 * @ptools/code-mode so Node and Cloudflare cannot drift.
 */
import { CodeModeServerLayer } from "@ptools/code-mode";

/**
 * Provides CodeModeServer from CodeMode inside the Cloudflare host graph.
 *
 * Prefer importing CodeModeServerLayer from @ptools/code-mode for new shared
 * code. This alias keeps the existing Cloudflare layer export stable.
 */
export const CloudflareCodeModeServerLayer = CodeModeServerLayer;
