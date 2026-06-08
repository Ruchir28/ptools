import { CodeModeObject } from "../objects/CodeModeObject.js";
import type { PtoolsWorkerEnv } from "./ingress.js";
import { cloudflareWorkerApp } from "./router.js";

const worker: ExportedHandler<PtoolsWorkerEnv> = {
  fetch: (request, env, ctx) => cloudflareWorkerApp.fetch(request, env, ctx),
};

export type { PtoolsWorkerEnv } from "./ingress.js";
export { CodeModeObject };
export default worker;
