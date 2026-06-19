import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(packageRoot, "dist/executor/sandbox-worker.js");
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src/executor/sandbox-worker.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: true,
});
