import { Hono } from "hono";
import { notFound } from "../errors.js";
import { errorResponse, type CloudflareWorkerHonoEnv } from "./http.js";
import { healthRoutes } from "./routes/health.js";
import { hostApiRoutes } from "./routes/hostApi.js";
import { oauthBrowserRoutes } from "./routes/oauthBrowser.js";

export const cloudflareWorkerApp = new Hono<CloudflareWorkerHonoEnv>()
  .route("/", healthRoutes)
  .route("/", hostApiRoutes)
  .route("/", oauthBrowserRoutes)
  .notFound(() => errorResponse(notFound()));
