import { CodeModeObject } from "../objects/CodeModeObject.js";
import type { PtoolsWorkerEnv } from "./ingress.js";
import { makeCloudflareHostHttpHandler } from "./sharedHostHttp.js";

type CloudflareHostHttpHandler = ReturnType<typeof makeCloudflareHostHttpHandler>;

/**
 * Worker-isolate cache for the shared Host HTTP handler.
 *
 * `HttpApiBuilder.toWebHandler(...)` returns an object that has its own lazy
 * runtime/handler cache internally, but that internal cache only lives as long
 * as the returned object lives. If we created a new Web handler inside every
 * `fetch`, Effect would also start with a fresh empty internal cache every
 * request.
 *
 * This module-level value is therefore the outer cache that keeps the returned
 * Web handler object alive across requests handled by the same Worker isolate
 * and env object. It is not global Cloudflare persistence: when Cloudflare
 * starts a new isolate, this value starts as `undefined` again.
 */
let cachedHostHttpHandler:
  | {
      readonly env: PtoolsWorkerEnv;
      readonly handler: CloudflareHostHttpHandler;
    }
  | undefined;

const worker: ExportedHandler<PtoolsWorkerEnv> = {
  fetch: (request, env) => {
    if (isHealthRequest(request)) {
      return handleHealthRequest(request);
    }

    return getHostHttpHandler(env).handler(request);
  },
};

const getHostHttpHandler = (env: PtoolsWorkerEnv): CloudflareHostHttpHandler => {
  if (cachedHostHttpHandler === undefined || cachedHostHttpHandler.env !== env) {
    cachedHostHttpHandler = {
      env,
      // This is the expensive/stable construction. Reusing this value means
      // later same-env requests do not rebuild the Effect layer graph or create
      // a new `toWebHandler(...)` object with a fresh internal cache.
      handler: makeCloudflareHostHttpHandler(env),
    };
  }

  return cachedHostHttpHandler.handler;
};

const isHealthRequest = (request: Request): boolean =>
  new URL(request.url).pathname === "/health";

const handleHealthRequest = (request: Request): Response => {
  if (request.method !== "GET") {
    return Response.json(
      { error: { code: "method_not_allowed", message: "Method not allowed" } },
      { status: 405, headers: { Allow: "GET" } },
    );
  }

  return Response.json({ ok: true });
};

export type { PtoolsWorkerEnv } from "./ingress.js";
export { CodeModeObject };
export default worker;
