# Ticket 5: Combined Code Mode MCP Server

## Summary

Implemented `apps/server` as the public MCP entrypoint for ptools.

V1 exposes one local stdio MCP server with two public tools:

```txt
search({ query?: string })
execute({ code, timeoutMs? })
```

Users configure upstream MCP servers in `ptools.config.json`. The server resolves that config, starts `McpRegistry`, `LocalSandboxExecutor`, and `CodeMode`, then serves the combined Code Mode surface to any MCP harness.

The public server stays thin. It does not discover upstream MCP tools itself and does not dispatch upstream calls directly. Discovery and dispatch still belong to `packages/mcp-registry`; provider orchestration still belongs to `packages/code-mode`; sandbox execution still belongs to `packages/executor`.

## Decisions

- Public combined MCP transport is stdio only for v1.
- Upstream MCP transports can be stdio or Streamable HTTP because `mcp-registry` already supports both.
- Config is JSON only for v1.
- `apps/server` owns config parsing and config-only conveniences like `envFrom` and `headersFromEnv`.
- `packages/mcp-registry` config types remain registry-compatible and do not include `envFrom` or `headersFromEnv`.
- Config validation uses `Effect.Schema`.
- MCP SDK tool input/output schemas use `zod`, so `apps/server` has a direct `zod` dependency.
- Startup/config/layer errors fail loudly by writing a safe message to `stderr` and exiting non-zero.
- Tool invocation errors after startup return MCP tool results with `isError: true`.
- `schemaCompiler` remains an internal Code Mode test seam and is not exposed through server config.
- The server key in config is the user-facing provider namespace source. For example, a config key of `fixture` produces `fixture.echo`, regardless of the fixture MCP server's internal name.

## Config Shape

Server-owned config:

```ts
interface PtoolsConfig {
  readonly mcpServers: Record<string, ServerMcpConfig>;
  readonly executor?: {
    readonly defaultTimeoutMs?: number;
  };
}

type ServerMcpConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      readonly envFrom?: Record<string, string>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly headersFromEnv?: Record<string, string>;
    };
```

Resolution rules:

- `env` and `headers` are literal values.
- `envFrom` maps target env key to source `process.env` key.
- `headersFromEnv` maps target header key to source `process.env` key.
- Missing env refs fail startup.
- After resolution, only literal `env` and `headers` are passed to `makeMcpRegistryLive`.
- Relative config paths resolve from `process.cwd()`.
- Config path is read from `--config <path>`, falling back to `PTOOLS_CONFIG`.

Example:

```jsonc
{
  "mcpServers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "envFrom": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"
      }
    },
    "remoteDocs": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headersFromEnv": {
        "authorization": "REMOTE_DOCS_AUTH"
      }
    }
  },
  "executor": {
    "defaultTimeoutMs": 30000
  }
}
```

## Implementation Notes

- Added `apps/server/src/config.ts`.
  - Parses `--config`.
  - Loads JSON.
  - Validates with `Effect.Schema`.
  - Resolves env/header refs into registry-compatible config.
- Added `apps/server/src/main.ts`.
  - Builds the scoped Effect graph:
    - `makeMcpRegistryLive(resolvedConfig.mcpServers)`
    - `makeLocalSandboxExecutorLive(resolvedConfig.executor)`
    - `makeCodeModeLive()`
  - Creates an SDK `McpServer`.
  - Registers `search` and `execute`.
  - Connects with `StdioServerTransport`.
  - Keeps the scope alive until stdio/process shutdown.
- Updated `apps/server/package.json`.
  - Added `test`.
  - Added direct `zod`.
- Updated `apps/server/tsconfig.json`.
  - Includes `src/**/*.ts` and `test/**/*.ts`.
  - Uses `rootDir: "."` so tests typecheck cleanly.

## Public Tool Behavior

`search`:

- input: `{ query?: string }`
- calls `CodeMode.search`
- returns `structuredContent` as the `CodeModeContext`
- returns text content with TypeScript declarations plus compact metadata

`execute`:

- input: `{ code: string, timeoutMs?: number }`
- calls `CodeMode.execute`
- returns `structuredContent` as `{ value, logs }`
- returns text content with a JSON-formatted result/log summary

## Tests

Added `apps/server/test/config.test.ts`:

- valid stdio config resolves into registry-compatible config
- valid HTTP config resolves into registry-compatible config
- literal `env` and `headers` are preserved
- `envFrom` and `headersFromEnv` resolve from an env map
- missing env refs fail loudly
- invalid config shape fails
- `--config` and `PTOOLS_CONFIG` path resolution works

Added `apps/server/test/server.integration.test.ts`:

- spawns the real `apps/server/src/main.ts` over stdio
- points it at the real fixture MCP server
- connects with the official MCP client
- asserts public tools are only `search` and `execute`
- calls `search()` and checks `fixture.echo` and `fixture.add`
- calls `search({ query: "echo" })` and checks filtered surface
- calls `execute({ code })` and proves generated JS can call `fixture.echo(...)` and `fixture.add(...)` through the full stack

Verified:

```bash
pnpm --filter @ptools/server typecheck
pnpm --filter @ptools/server test
pnpm --filter @ptools/server build
pnpm test
pnpm typecheck
pnpm build
```

## Non-Goals

- No public HTTP combined MCP server yet.
- No remote deployment/auth model yet.
- No user-local MCP bridge for remote hosts yet.
- No dynamic MCP config reload yet.
- No direct exposure of upstream MCP tools as individual public tools.
