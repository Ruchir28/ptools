import { defineConfig } from "drizzle-kit";

/** Build-time migration generation for the Node-owned control-plane database. */
export default defineConfig({
  dialect: "sqlite",
  schema:
    "./src/hostControlPlaneDaemon/persistence/nodeControlPlaneSqliteSchema.ts",
  out: "./drizzle/node-control-plane",
});
