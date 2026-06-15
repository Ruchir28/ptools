import { Hono } from "hono";
import { notFound } from "../errors.js";
import { errorResponse, type CloudflareWorkerHonoEnv } from "./http.js";
import { codeModeRoutes } from "./routes/codeMode.js";
import { configRoutes } from "./routes/config.js";
import { healthRoutes } from "./routes/health.js";
import { mcpAuthRoutes } from "./routes/mcpAuth.js";

export const cloudflareWorkerApp = new Hono<CloudflareWorkerHonoEnv>()
  .route("/", healthRoutes)
  .route("/", codeModeRoutes)
  .route("/", configRoutes)
  .route("/", mcpAuthRoutes)
  .notFound(() => errorResponse(notFound()));
