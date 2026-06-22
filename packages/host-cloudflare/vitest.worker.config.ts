import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.test.jsonc",
      },
    }),
  ],
  // Worker tests run code inside workerd (via Miniflare), not in Node. When a
  // dependency cannot be loaded in the isolate, workerd calls Vitest's module
  // fallback service (`@cloudflare/vitest-pool-workers`) to read files from
  // disk and register them as runtime modules.
  //
  // `@ptools/code-mode` pulls in this chain at Worker load time:
  //   json-schema-to-typescript → @apidevtools/json-schema-ref-parser → @jsdevtools/ono
  //
  // `@jsdevtools/ono` is a dual package (`main`: CJS, `module`: ESM). Resolution
  // picks `esm/index.js`, which does `import { ono } from "./singleton"`. The file
  // `esm/singleton.js` exists; the failure is resolver behavior in the test bridge,
  // not a missing package.
  //
  // Where vitest-pool-workers fails (see `dist/pool/index.mjs` in the package):
  //
  // 1) `load()` treats `esm/index.js` as native ESM because `isWithinTypeModuleContext()`
  //    returns true when `package.json`'s `"module"` field equals that file path. workerd
  //    then executes the raw source, including `import "./singleton"`.
  //
  // 2) workerd asks the fallback service to load `./singleton` with
  //    `X-Resolve-Method: import` and target `.../esm/singleton` (no `.js` suffix).
  //
  // 3) `maybeGetTargetFilePath(target, isRequire)` only appends `.js` when
  //    `isRequire === true`:
  //
  //      if (isFile(target)) return target;
  //      if (isRequire) for (const ext of [".js", ".mjs", ".cjs", ".json"]) {
  //        if (exists(target + ext)) return target + ext;
  //      }
  //
  //    For ESM `import`, `isRequire` is false, so `.../singleton` is not upgraded to
  //    `.../singleton.js`. The fallback also reconstructs the source specifier from
  //    paths as `singleton` instead of the original relative `./singleton`, so Vite
  //    sees a bare package import and cannot recover the local file resolution.
  //    workerd then reports "No such module .../esm/singleton".
  //
  // 4) The CJS entry avoids that path: `load()` serves `{ commonJsModule }` for
  //    `cjs/index.js` (not the `"module"` entry), and `require("./singleton")` hits
  //    the `isRequire` branch above, which finds `singleton.js`.
  //
  // workerd is ESM-first and does not "prefer CJS". Aliasing to `cjs/index.js`
  // sidesteps the broken ESM sub-import path in this test harness only.
  //
  // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution
  //
  // The alias is test-only and targets the installed transitive dependency that
  // reaches this Worker through `json-schema-to-typescript`.
  resolve: {
    alias: {
      "@jsdevtools/ono": require.resolve("@jsdevtools/ono/cjs/index.js"),
    },
  },
  test: {
    include: ["test/worker.test.ts", "test/codeModeRuntime.test.ts"],
    globalSetup: ["./test/fixtureMcpGlobalSetup.ts"],
    testTimeout: 10_000,
  },
});
