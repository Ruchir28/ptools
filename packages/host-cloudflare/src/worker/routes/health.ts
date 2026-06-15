import { Hono } from "hono";
import { methodNotAllowed } from "../../errors.js";
import { errorResponse, type CloudflareWorkerHonoEnv } from "../http.js";

export const healthRoutes = new Hono<CloudflareWorkerHonoEnv>()
  .get("/health", (context) => context.json({ ok: true }))
  .all("/health", () => errorResponse(methodNotAllowed(["GET"])));
