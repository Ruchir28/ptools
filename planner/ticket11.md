# Ticket 11: Publishable Alpha Package Readiness

## Summary

Make the AI SDK-first `@ptools/agent-tools` path installable from npm packages
without relying on monorepo workspace links or repo-local files.

The alpha package set is:

```txt
@ptools/agent-tools
@ptools/core
@ptools/code-mode
@ptools/executor
@ptools/mcp-registry
```

The intended user path after this ticket:

```bash
npm install @ptools/agent-tools
```

```ts
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { createPtoolsSessionFromConfigFile } from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";

const ptools = await createPtoolsSessionFromConfigFile();

try {
  const result = await generateText({
    model: openai("gpt-5.4"),
    tools: toAISDKTools(ptools),
    stopWhen: stepCountIs(8),
    prompt: "Use the configured MCP servers to answer this.",
  });

  console.log(result.text);
} finally {
  await ptools.close();
}
```

This ticket should not publish anything to npm. It should make local package
artifacts look and behave like publishable npm packages, then validate them in
a clean temp project.

## Problem

Ticket 10 makes config loading user-shaped, but the library still assumes repo
context:

- publishable packages are marked `private: true`
- internal dependencies use `workspace:*`
- package tarballs may include source, tests, build metadata, or local-only
  files
- there is no package-level README or LICENSE story for install users
- there is no smoke test proving a non-workspace project can install and run
  the AI SDK path

That means the first mile is still incomplete. A user can see the API shape, but
cannot trust that `npm install @ptools/agent-tools` will resolve the internal
packages and expose only the intended package contents.

## Research Notes

Relevant npm and pnpm behavior to account for:

- npm refuses to publish packages with `"private": true`.
- npm `publishConfig` is the right place to pin publish-time settings such as
  public access for scoped packages.
- npm `pack` is the local way to inspect the exact package archive before
  publishing.
- pnpm workspace publishing can pack workspace packages and includes the root
  LICENSE in workspace package archives when a package does not have its own
  license.
- pnpm supports publish-time manifest overrides through `publishConfig`, but
  this ticket should avoid clever publish-directory rewrites unless they are
  needed.

Prefer boring package manifests plus an explicit `files` whitelist over
`.npmignore`-driven cleanup.

## Desired Package Set

### Publishable

Make these packages publishable because `@ptools/agent-tools` needs them at
runtime:

- `@ptools/agent-tools`
- `@ptools/core`
- `@ptools/code-mode`
- `@ptools/executor`
- `@ptools/mcp-registry`

### Private

Keep these private in this ticket:

- root `ptools`
- `@ptools/server`
- `@ptools/playground`
- examples

The combined MCP server and playground are separate product surfaces. Do not
accidentally make them part of the alpha library release.

## Package Metadata

For every publishable package:

- remove `"private": true`
- set a real prerelease version
- add `license`
- add `repository`
- add `homepage` if the repository URL is known
- add `bugs` if the issue URL is known
- add `files`
- add `publishConfig`
- keep ESM package shape
- preserve existing `exports`

Suggested initial version:

```json
"version": "0.1.0-alpha.0"
```

Use the same version across all publishable `@ptools/*` packages for the alpha.
Packed internal dependency ranges should resolve to that same version. Keep
`workspace:*` in source manifests for local development; validate pnpm rewrites
those ranges in the packed artifacts.

For alpha, this is a fixed release train:

```txt
@ptools/core          0.1.0-alpha.0
@ptools/mcp-registry 0.1.0-alpha.0
@ptools/code-mode    0.1.0-alpha.0
@ptools/executor     0.1.0-alpha.0
@ptools/agent-tools  0.1.0-alpha.0
```

If only `@ptools/core` changes, the next alpha should still publish a coherent
package set:

```txt
@ptools/core          0.1.0-alpha.1
@ptools/mcp-registry 0.1.0-alpha.1
@ptools/code-mode    0.1.0-alpha.1
@ptools/executor     0.1.0-alpha.1
@ptools/agent-tools  0.1.0-alpha.1
```

Even packages with no source changes may need a republish because their packed
dependency metadata points at the internal package versions they were validated
with. For example, if `@ptools/agent-tools@0.1.0-alpha.0` depends on
`@ptools/core@0.1.0-alpha.0`, publishing only
`@ptools/core@0.1.0-alpha.1` does not make existing installs of
`@ptools/agent-tools@0.1.0-alpha.0` automatically use the new core when exact
internal dependency ranges are used.

This keeps alpha support simple: one version identifies one tested ptools
runtime set. Revisit independent package versioning later if internal packages
become stable public products with independent consumers.

Suggested publish config for scoped public packages:

```json
"publishConfig": {
  "access": "public"
}
```

If the final repo URL is not known yet, use a clear placeholder only in the
ticket implementation branch and call it out before publishing. Do not silently
publish with fake repository metadata.

## Package Contents

Each publishable package should pack only:

```txt
dist/
README.md
LICENSE
package.json
```

No package tarball should include:

- `src/`
- `test/`
- `*.tsbuildinfo`
- `tsconfig*.json`
- local fixtures
- planner files
- examples
- repo-only scripts

Use a `files` whitelist in each package:

```json
"files": [
  "dist",
  "README.md",
  "LICENSE"
]
```

Check whether per-package `LICENSE` files or root LICENSE propagation gives the
cleanest dry-run result with pnpm. The validation target is still that each
tarball visibly includes a license file.

## Dependency Ranges

Published package artifacts must not contain internal dependency ranges like:

```json
"@ptools/core": "workspace:*"
```

Registry consumers cannot resolve workspace-only ranges. The packed/published
manifest should contain the chosen alpha version range instead:

```json
"@ptools/core": "0.1.0-alpha.0"
```

Keep `workspace:*` in source manifests for local development. pnpm documents
that workspace dependencies are dynamically replaced with regular version specs
when a workspace package is packed or published. The release check must inspect
the packed `package.json` files and fail if any `workspace:*` range remains in
the artifact.

The source repo should remain pleasant to develop in; the hard requirement is
that the release artifact is installable outside the workspace.

Do this check only for publishable packages. Private apps and examples may keep
workspace dependencies unless the smoke-test workflow requires a separate
published-package example.

For external dependencies, choose deliberate ranges:

- avoid `"latest"` in publishable packages
- use the installed lockfile versions as the starting point
- keep peer dependency decisions explicit

`@ptools/agent-tools` depends on `ai` for the AI SDK subpath. For this alpha,
keep it as a normal dependency unless implementation review shows the package
can safely make the AI SDK adapter optional without breaking
`@ptools/agent-tools/ai-sdk`.

## README Docs

Add or update package READMEs for the publishable surface.

Docs for this alpha should optimize for one question:

```txt
I installed @ptools/agent-tools. How do I connect my MCP servers and use them
from an AI SDK model?
```

Do not start with architecture. Start with the user journey:

1. install the package
2. create `ptools.config.json`
3. create a session from that config
4. pass `toAISDKTools(ptools)` into AI SDK
5. close the session
6. debug common config and MCP startup failures

The docs should be package-local for this ticket:

- `packages/agent-tools/README.md` is the primary public docs page
- short package READMEs exist for the internal runtime packages
- `examples/ai-sdk-real-model/README.md` can point back to the package README
  and remain an example-specific walkthrough

Do not add a docs site yet. A package README plus a validated example is enough
for alpha.

### Docs Maintenance Model

Follow the same broad shape as mature SDK repos such as Cloudflare Agents:

- root README: product overview, package map, quick example, links to examples
  and deeper docs
- package README: npm-user installation and API usage for that package
- examples: runnable, self-contained demos that prove the README path works
- future docs site: only after the core package surface has stabilized enough
  to justify separate long-form docs

For this alpha, make `packages/agent-tools/README.md` the source of truth for
the installable library path. Keep `examples/ai-sdk-real-model/README.md`
example-specific and link it back to the package README.

Docs should be validated as part of release readiness:

- README code snippets should mirror real exported APIs.
- The example config should be accepted by the actual config loader.
- The AI SDK snippet should be close to a runnable example, not pseudocode.
- The temp-project smoke test should cover the same public imports shown in the
  README.
- If exported names change, update README snippets in the same PR.

Do not document internal runtime packages as first-class user products yet.
They may have short READMEs for npm/package hygiene, but the user-facing docs
should point users to `@ptools/agent-tools` and, later, `@ptools/server`.

### `@ptools/agent-tools` README

This is the primary user-facing README and should include:

- install command
- minimal `ptools.config.json`
- `createPtoolsSessionFromConfigFile()` usage
- `toAISDKTools()` usage with AI SDK
- lifecycle guidance with `await ptools.close()`
- note that the exposed Code Mode tools are `search`, `get_tool_schema`, and
  `execute`
- note that OpenAI and Anthropic direct adapters are follow-ups
- troubleshooting for missing config files, missing env vars, and broken MCP
  server startup
- a short "what gets exposed to the model" section that explains Code Mode
  tools without describing every internal package

Recommended README outline:

```txt
# @ptools/agent-tools

## Install
## Configure MCP Servers
## Use With AI SDK
## Session Lifecycle
## What Tools The Model Sees
## Troubleshooting
## Status And Roadmap
```

Example config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Example session lifecycle:

```ts
const ptools = await createPtoolsSessionFromConfigFile();

try {
  const tools = toAISDKTools(ptools);
  // pass tools to generateText / streamText
} finally {
  await ptools.close();
}
```

Troubleshooting should map common user-facing failures to fixes:

- `ptools.config.json` not found: create the file or pass an explicit path.
- `${env:NAME}` missing: export the env var before starting the app.
- MCP server command fails: run the command manually and check the server
  package docs.
- model calls fail: inspect `await ptools.diagnostics()` before the model run.

Keep troubleshooting honest: surface config and MCP contract problems directly
instead of suggesting permissive fallbacks.

### Internal Package READMEs

Internal dependency packages can have short READMEs that say they are runtime
building blocks for `@ptools/agent-tools`:

- `@ptools/core`
- `@ptools/code-mode`
- `@ptools/executor`
- `@ptools/mcp-registry`

Do not over-document these as separate public products yet.

## Implementation Notes

### Manifest Updates

Update:

- `packages/agent-tools/package.json`
- `packages/core/package.json`
- `packages/code-mode/package.json`
- `packages/executor/package.json`
- `packages/mcp-registry/package.json`

Keep `apps/server/package.json`, `apps/playground/package.json`, examples, and
the root package private.

### Version Consistency

Add a small validation script if it keeps the release check boring:

```txt
scripts/check-publishable-packages.mjs
```

It should verify:

- all publishable packages have the same version
- no publishable package has `private: true`
- every publishable package has `files`
- every publishable package has `license`
- every publishable package has `publishConfig.access = "public"`

If source manifests intentionally keep `workspace:*`, the script should either:

- skip that source-manifest check and let pack validation own it
- or offer a separate artifact check that reads the packed `package.json`
  contents and fails if any `workspace:*` range remains

Wire it into a script such as:

```json
"check:publishable": "node scripts/check-publishable-packages.mjs"
```

If a script feels heavier than the implementation needs, keep the same checks
documented and manually validated in this ticket. The important part is that
release validation is repeatable.

### Pack Validation

Add a root script if useful:

```json
"pack:dry-run": "pnpm -r --filter './packages/*' pack --dry-run"
```

If pnpm filtering makes the output noisy, prefer explicit package commands over
a clever recursive script.

The implementation should inspect every publishable package dry-run output and
confirm that only the intended files are included.

It should also inspect the packed manifest for every publishable package and
confirm that no `workspace:*` dependency range remains in the artifact.

### Temp Install Smoke Test

Create a temporary project outside the workspace during validation:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y
npm install /path/to/ptools/packages/core/ptools-core-0.1.0-alpha.0.tgz \
  /path/to/ptools/packages/executor/ptools-executor-0.1.0-alpha.0.tgz \
  /path/to/ptools/packages/mcp-registry/ptools-mcp-registry-0.1.0-alpha.0.tgz \
  /path/to/ptools/packages/code-mode/ptools-code-mode-0.1.0-alpha.0.tgz \
  /path/to/ptools/packages/agent-tools/ptools-agent-tools-0.1.0-alpha.0.tgz
```

Then run a tiny import smoke test:

```js
import {
  createPtoolsSessionFromConfigFile,
} from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";

console.log(typeof createPtoolsSessionFromConfigFile);
console.log(typeof toAISDKTools);
```

If feasible, also run one config-backed session with a tiny local stdio MCP
fixture copied into the temp project. The minimum acceptance bar is that the
published package graph installs and the public ESM imports resolve without
workspace context.

## Tests

This ticket is mostly packaging, but add tests when package scripts or README
examples introduce executable behavior.

At minimum, keep the existing behavior test suite green:

```bash
pnpm --filter @ptools/agent-tools test
pnpm --filter @ptools/core test
pnpm --filter @ptools/code-mode test
pnpm --filter @ptools/executor test
pnpm --filter @ptools/mcp-registry test
```

If a publishable validation script is added, test it by making sure it fails on
a temporary copied manifest or by keeping it simple enough that the dry-run and
temp-install validation are the test.

## Verification

Before considering this ticket complete, run:

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm check:publishable
```

Then for every publishable package:

```bash
npm pack --dry-run
```

Finally, create real local tarballs and validate installation from a temp
project:

```bash
npm pack
# install the generated tarballs into a temp project
# run the ESM import smoke test
```

The completion note should include:

- the package version chosen
- the package set validated
- pack dry-run summary
- temp install smoke-test command and result
- any metadata that must be replaced before real publish, such as repository URL

## Acceptance Criteria

- `@ptools/agent-tools` can be installed into a non-workspace temp project from
  local tarballs with its internal `@ptools/*` dependencies.
- Public imports resolve:
  - `@ptools/agent-tools`
  - `@ptools/agent-tools/ai-sdk`
- Publishable package manifests no longer contain `private: true`.
- Packed publishable package manifests do not contain `workspace:*` dependency
  ranges.
- Publishable package tarballs include only `dist`, `README.md`, `LICENSE`, and
  `package.json`.
- `@ptools/agent-tools` README documents install, config-file session creation,
  AI SDK adapter usage, and `close()` lifecycle.
- Root build, typecheck, tests, dry-run pack, and temp install smoke test pass.

## Future Follow-Ups

- Actual npm publish workflow.
- Changelog and release notes generation.
- Changesets or another versioning/release-management tool.
- Direct OpenAI Responses adapter.
- Direct Anthropic Messages adapter.
- Separate package docs site.
- Optional dependency strategy for adapter subpaths if AI SDK should become
  avoidable for non-AI-SDK users.

## Out Of Scope

- Publishing to npm.
- Adding OpenAI or Anthropic direct adapters.
- Adding a CLI.
- Making `@ptools/server` publishable.
- Making the playground publishable.
- Reworking the config shape from Ticket 10.
- Changing the Code Mode public tool contract.
- Replacing the executor implementation.
- Introducing a docs site.
