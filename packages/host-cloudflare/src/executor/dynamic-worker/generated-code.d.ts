/**
 * @file Type declaration for the runtime-only `generated-code.js` module.
 *
 * `generated-code.js` is not a source file in this package; it is rendered per
 * execution by `generatedCodeModuleRenderer.ts` and supplied to Cloudflare
 * Worker Loader. This declaration lets TypeScript typecheck the fixed
 * `cloudflareKernelAdapter.ts` import that Cloudflare resolves at runtime.
 */
import type { SandboxProgram } from "@ptools/executor/sandbox";

export const bindingKeys: ReadonlyArray<string>;
declare const runGenerated: SandboxProgram;
export default runGenerated;
