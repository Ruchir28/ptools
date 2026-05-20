# Ticket 10: Config-File Sessions For Agent Tools

## Summary

Add a config-file session factory to `@ptools/agent-tools` so library users can
start from the same `ptools.config.json` shape used by the combined MCP server.

The intended starter API:

```ts
import { createPtoolsSessionFromConfigFile } from "@ptools/agent-tools";
import { toAISDKTools } from "@ptools/agent-tools/ai-sdk";

const ptools = await createPtoolsSessionFromConfigFile();

try {
  const tools = toAISDKTools(ptools);
  // pass tools to generateText / streamText
} finally {
  await ptools.close();
}
```

Keep the existing lower-level factory for programmatic callers:

```ts
const ptools = await createPtoolsSession({
  mcpServers,
  executor,
});
```

This ticket is the bridge between the implemented AI SDK adapter and a usable
published library. Release docs should be written against this config-file
happy path, so this comes before release-readiness work.

Default discovery is intentionally narrow: no global/project merge, no
client-specific imports, and no environment fallback. Calling
`createPtoolsSessionFromConfigFile()` with no path should only look for
`ptools.config.json` in `options.cwd ?? process.cwd()`.

## Problem

`@ptools/agent-tools` currently accepts resolved `mcpServers` config only. That
is useful for internal tests and advanced callers, but it is too low-level for a
library user who already has or expects an MCP config file.

The combined MCP server already supports:

```txt
--config <path>
PTOOLS_CONFIG=<path>
```

and validates / resolves:

- stdio MCP servers
- HTTP MCP servers
- literal `env` and `headers`
- normal MCP-style env/header references
- executor defaults

The library should reuse that config behavior instead of creating a second
config dialect or asking users to duplicate parsing and secret resolution in
application code.

There is one important product concern: users should not have to hand-convert a
normal MCP client config into a ptools-only dialect. A config copied from common
MCP clients should either work directly or fail with a specific explanation of
the unsupported field.

## Research Notes

Adjacent libraries and tools support config-file loading, but in slightly
different ways:

- `mcp-use` supports JSON config files, inline config objects, and a dedicated
  config-file factory such as `MCPClient.fromConfigFile("./mcp-config.json")`.
- OpenAI Codex treats MCP configuration as first-class app configuration in
  `~/.codex/config.toml` and project-scoped `.codex/config.toml`.
- Cloudflare `@cloudflare/codemode` is mostly programmatic: callers pass tools
  and an executor directly. MCP tools are merged from an already-owned MCP
  runtime, so the Code Mode library itself does not appear to own a general MCP
  config-file loader.
- Claude Desktop, Cursor, Windsurf, GitHub Copilot CLI, and many MCP server
  READMEs converge on a JSON shape with a top-level `mcpServers` object.
  Stdio servers usually use `{ "command": "...", "args": [...], "env": {...} }`
  with no explicit transport field. Remote servers usually use `{ "url": "...",
  "headers": {...} }`.

`ptools` is closer to `mcp-use` for this concern because the product starts from
many configured MCP servers and turns them into one Code Mode surface.

The current ptools config shape is close, but too strict for easy setup because
it requires `transport: "stdio" | "http"`. This ticket should make normal MCP
JSON the canonical config shape: `command` implies stdio and `url` implies HTTP.

## Desired Public API

### Core Exports

Extend the root `@ptools/agent-tools` export:

```ts
export {
  createPtoolsSession,
  createPtoolsSessionFromConfigFile,
  loadPtoolsSessionConfig,
} from "./session.js";

export { ServerConfigError } from "@ptools/core";

export type {
  CodeModeToolName,
  CreatePtoolsSessionOptions,
  CreatePtoolsSessionFromConfigFileOptions,
  PtoolsSession,
  ToolNameOptions,
} from "./types.js";
```

### Config-File Factory

```ts
export const createPtoolsSessionFromConfigFile = (
  path?: string,
  options?: CreatePtoolsSessionFromConfigFileOptions,
) => Promise<PtoolsSession>;
```

Options:

```ts
interface CreatePtoolsSessionFromConfigFileOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}
```

Behavior:

- `path` is optional and defaults to `"ptools.config.json"`.
- Explicit and default paths may be absolute or relative.
- Relative config file paths resolve from `options.cwd ?? process.cwd()`.
- Relative stdio server `cwd` values inside the config resolve from the
  directory containing the resolved config file, not the caller's
  `process.cwd()`.
- `${env:NAME}` placeholders inside config string values resolve from
  `options.env ?? process.env`.
- The returned session is the same `PtoolsSession` returned by
  `createPtoolsSession`.
- Config, parse, validation, and missing-env failures should reject the Promise
  with clear errors from the shared config loader.
- `ServerConfigError` should be exported from the public
  `@ptools/agent-tools` root entrypoint so consumers can catch config failures
  programmatically.

### Manual Config Loading

Expose a manual loader for advanced callers and tests:

```ts
export const loadPtoolsSessionConfig = (
  path?: string,
  options?: CreatePtoolsSessionFromConfigFileOptions,
) => Promise<CreatePtoolsSessionOptions>;
```

This should return the resolved session options that can be passed directly to:

```ts
await createPtoolsSession(config);
```

Do not expose the unresolved config shape from `@ptools/agent-tools` in v1.
Keep the root user path oriented around "load file, create session".

### Config Shape

The loader should accept one canonical config shape: normal MCP JSON with a
top-level `mcpServers` object.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}"
      }
    },
    "context7": {
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

Normalization rules:

- If `command` is present, infer stdio.
- If `url` is present, infer HTTP.
- If both `command` and `url` are present, fail clearly instead of guessing.
- If neither `command` nor `url` is present, fail clearly.
- `transport` and `type` are not part of the canonical ptools config shape and
  should fail with a message that says to use `command` or `url` instead.
- Relative stdio `cwd` paths are resolved against the config file directory.
- Support the normal MCP convention for secrets: `${env:NAME}` placeholders in
  string values under `command`, `args`, `cwd`, `env`, `url`, and `headers`
  resolve from `options.env ?? process.env`.
- Missing environment variables referenced by `${env:NAME}` fail during config
  loading.
- Preserve literal `env` and `headers` values when they do not contain
  placeholders.

Unsupported fields should fail with useful messages when they imply behavior
ptools does not implement yet. Operationally neutral copied fields may be
accepted only when they match ptools' default behavior:

- Accept `disabled: false` and `enabled: true`.
- Support `disabled: true` and `enabled: false` by excluding that server from
  the resolved config.
- Reject behavior-altering fields such as OAuth/auth blocks, approval policy,
  `envFile`, and tool allow/deny lists.

## Key Decisions

- Reuse `loadPtoolsConfig` from `@ptools/core`. Do not duplicate JSON parsing,
  Effect Schema validation, env resolution, or error message construction in
  `@ptools/agent-tools`.
- Make conventional MCP JSON the canonical shared `@ptools/core` config shape,
  because both `apps/server` and `@ptools/agent-tools` should have the same
  config behavior.
- Keep `createPtoolsSession({ mcpServers, executor })` as the low-level
  programmatic API.
- Add a separate `createPtoolsSessionFromConfigFile(...)` factory instead of
  overloading `createPtoolsSession(...)` with `string | object`.
- Allow `createPtoolsSessionFromConfigFile()` and `loadPtoolsSessionConfig()`
  without a path. The only implicit lookup is `ptools.config.json` in
  `options.cwd ?? process.cwd()`.
- Do not add CLI arg parsing to the library helper. `resolveConfigPath` remains
  server/CLI-owned behavior.
- Do not add broad templating, VS Code `inputs`, `.env` file loading, or
  client-specific config merging in this ticket. Only support `${env:NAME}`
  environment placeholders.
- Fail fast when the file is missing, JSON is invalid, config shape is invalid,
  or referenced env vars are absent.
- Preserve MCP-first layering: the config file still resolves into registry
  config, then `createPtoolsSession` constructs registry, executor, and Code
  Mode layers.

## Implementation Notes

### `packages/agent-tools/src/types.ts`

Add:

```ts
export interface CreatePtoolsSessionFromConfigFileOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}
```

Consider whether the loader return type should reuse
`CreatePtoolsSessionOptions` exactly. The shared core loader currently returns
resolved config that is already compatible with `createPtoolsSession`.

### `packages/agent-tools/src/session.ts`

Add a small path-resolution helper:

```ts
const resolveConfigFilePath = (path: string, cwd: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path);
```

Then:

```ts
export const loadPtoolsSessionConfig = async (
  path = "ptools.config.json",
  options: CreatePtoolsSessionFromConfigFileOptions = {},
): Promise<CreatePtoolsSessionOptions> => {
  const resolvedPath = resolveConfigFilePath(path, options.cwd ?? process.cwd());
  const config = await Effect.runPromise(
    loadPtoolsConfig(resolvedPath, options.env ?? process.env, {
      baseDir: dirname(resolvedPath),
    }),
  );

  return config;
};
```

and:

```ts
export const createPtoolsSessionFromConfigFile = async (
  path?: string,
  options?: CreatePtoolsSessionFromConfigFileOptions,
): Promise<PtoolsSession> => createPtoolsSession(
  await loadPtoolsSessionConfig(path, options),
);
```

Keep the existing `makePtoolsSession` test helper if useful. It should remain
an internal test convenience unless there is a clear user-facing reason to
export it.

### `packages/core/src/config.ts`

Update the shared config schema/normalization path so it accepts both:

- conventional MCP entries where `command` implies stdio and `url` implies HTTP
- a config-file base directory used to resolve relative stdio `cwd` values
- `${env:NAME}` placeholders in string values, resolved from the provided env
  map
- `enabled` / `disabled` fields for including or excluding servers

If a config contains unsupported fields that users may copy from other clients,
handle them deliberately:

- `type` and `transport` are out of scope. Use `command` for stdio servers and
  `url` for HTTP servers.
- `serverUrl` is out of scope; use `url`.
- `disabled: false` and `enabled: true` are neutral.
- `disabled: true` and `enabled: false` should exclude that server from the
  resolved config.
- `tools`, `enabled_tools`, `disabled_tools`, `envFile`, OAuth/auth blocks, and
  approval-policy fields are out of scope for behavior in this ticket. Reject
  these with a clear message rather than silently ignoring them.

Export `ServerConfigError` from `@ptools/agent-tools` so library consumers do
not need to import from the internal `@ptools/core` package.

### `packages/agent-tools/src/index.ts`

Export the new helpers and option type.

### Example Config

Prefer examples that look like normal MCP JSON:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}"
      }
    },
    "remoteDocs": {
      "url": "https://example.com/mcp",
      "headers": {
        "authorization": "Bearer ${env:REMOTE_DOCS_AUTH}"
      }
    }
  },
  "executor": {
    "defaultTimeoutMs": 30000
  }
}
```

## Tests

### Config Loading

Add focused tests under `packages/agent-tools/test/`:

- `loadPtoolsSessionConfig` loads a valid config file.
- `createPtoolsSessionFromConfigFile()` defaults to `ptools.config.json` in
  `options.cwd ?? process.cwd()`.
- Common MCP stdio config loads and normalizes.
- Common MCP HTTP config loads and normalizes.
- Configs containing `transport` or `type` reject clearly.
- Relative paths resolve from `options.cwd`.
- Relative stdio server `cwd` values resolve from the config file directory.
- Absolute paths are used as-is.
- `${env:NAME}` resolves inside stdio `env` from `options.env`.
- `${env:NAME}` resolves inside HTTP `headers` from `options.env`.
- Missing `${env:NAME}` refs reject with a clear error.
- Ambiguous configs with both `command` and `url` reject clearly.
- `disabled: false` and `enabled: true` are accepted.
- `disabled: true` and `enabled: false` exclude the server from resolved config.
- Missing env refs reject with a clear error.
- Invalid JSON rejects with a clear error.
- Invalid config shape rejects with a clear error.
- `ServerConfigError` is exported from the public `@ptools/agent-tools`
  entrypoint and can be used in `instanceof` checks.

### Session Factory

Add a vertical test with the existing stdio fixture:

```txt
createPtoolsSessionFromConfigFile
  -> search
  -> get_tool_schema
  -> execute code calling fixture provider
  -> fixture MCP tool receives original MCP call
```

This should prove the file-based path reaches the same runtime behavior as the
programmatic `createPtoolsSession` path.

### AI SDK Adapter Compatibility

Add or adjust one test proving:

```txt
createPtoolsSessionFromConfigFile
  -> toAISDKTools
  -> ptools_search / ptools_get_tool_schema / ptools_execute
```

The adapter should not know or care whether the session came from a file or an
inline object.

## Verification

Before considering this ticket complete, run:

```bash
pnpm --filter @ptools/agent-tools test
pnpm --filter @ptools/agent-tools typecheck
pnpm typecheck
pnpm build
```

If shared core config behavior changes, also run:

```bash
pnpm --filter @ptools/core test
pnpm --filter @ptools/core typecheck
```

## Future Follow-Ups

- Release-readiness ticket: package metadata, `files` whitelist, README,
  LICENSE, `npm pack --dry-run`, and publish workflow.
- Config docs: happy-path `ptools.config.json`, `${env:NAME}` secrets, and AI
  SDK example.
- Additional adapters such as OpenAI Responses or Anthropic Messages.

## Out Of Scope

- Publishing packages to npm.
- README/release docs beyond examples needed to explain this ticket.
- CLI arg parsing in `@ptools/agent-tools`.
- `PTOOLS_CONFIG` env fallback in `@ptools/agent-tools`.
- TOML config support.
- Project/user-level config discovery like Codex.
- Runtime add/remove server APIs.
- OAuth or approval policy.
- Broad variable interpolation beyond `${env:NAME}`.
- Automatic loading of `.env` or `envFile`.
- Automatic merge of global/project config files.
