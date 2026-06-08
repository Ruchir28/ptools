import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker-entry.ts",
      miniflare: {
        compatibilityDate: "2026-05-22",
        bindings: {
          PTOOLS_PUBLIC_ACCESS_TOKEN: "test-public-token",
        },
        durableObjects: {
          PTOOLS_CODE_MODE: "TestCodeModeObject",
        },
      },
    }),
  ],
  test: {
    include: ["test/worker.test.ts"],
  },
});
