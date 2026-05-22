import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { publishablePackages } from "./publishable-packages.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const tmp = await mkdtemp(join(tmpdir(), "ptools-smoke-"));
const packDir = join(tmp, "tarballs");
const projectDir = join(tmp, "project");
const npmCacheDir = join(tmp, "npm-cache");

const exec = (command, args, options = {}) =>
  execFileSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: npmCacheDir,
      npm_config_cache: npmCacheDir,
    },
    ...options,
  });

try {
  exec("mkdir", ["-p", packDir, projectDir]);

  for (const pkg of publishablePackages) {
    exec("pnpm", [
      "--dir",
      join(root, pkg.dir),
      "pack",
      "--pack-destination",
      packDir,
    ]);
  }

  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2),
  );

  const tarballPaths = execFileSync("find", [
    packDir,
    "-type",
    "f",
    "-name",
    "*.tgz",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

  exec("npm", ["install", ...tarballPaths], { cwd: projectDir });

  await writeFile(
    join(projectDir, "smoke.mjs"),
    [
      'import { createPtoolsSessionFromConfigFile } from "@ptools/agent-tools";',
      'import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";',
      "",
      'if (typeof createPtoolsSessionFromConfigFile !== "function") {',
      '  throw new Error("createPtoolsSessionFromConfigFile did not resolve");',
      "}",
      'if (typeof toAISDKTools !== "function") {',
      '  throw new Error("toAISDKTools did not resolve");',
      "}",
      'console.log("packed install smoke ok");',
    ].join("\n"),
  );

  exec("node", ["smoke.mjs"], { cwd: projectDir });
} finally {
  await rm(tmp, { recursive: true, force: true });
}
