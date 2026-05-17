# Ticket 7: MCP Playground (`apps/playground`)

## Summary

A browser-based developer playground for inspecting and executing ptools Code Mode. It runs as a local HTTP server that embeds a Vite dev server for the React frontend and exposes a JSON API that the frontend consumes. Developers use it to inspect connected MCP servers, browse generated tool APIs and schemas, and execute generated JavaScript code against live MCP tools.

## How to Run

```bash
# with --config flag
pnpm playground --config ./ptools.config.json

# or with environment variable
PTOOLS_CONFIG=./ptools.config.json pnpm playground

# with a specific API key required by the config
EXA_API_KEY=your_key PTOOLS_CONFIG=./ptools-exa.config.json pnpm playground
```

Default port: `5178`. Override with `--port <n>` or `PLAYGROUND_PORT=<n>`.

## Architecture

```
pnpm playground --config <path>
  -> apps/playground/src/playground.ts  (Node HTTP server + Vite dev server)
  -> loads ptools config via @ptools/core resolveConfigPath / loadPtoolsConfig
  -> builds CodeMode layer from MCP registry + local sandbox executor
  -> serves JSON API:
       GET  /api/context           -> CodeModeContext (servers, tools, diagnostics)
       POST /api/tool-declarations -> generated TS declarations for a tool
       POST /api/execute           -> runs user code through the executor
  -> proxies all other requests to Vite (React SPA)
```

### Server (`src/playground.ts`)
- Entry: `runPlayground(argv, env, cwd)` — Effect-based, stays alive until stdin closes
- `resolvePlaygroundPort` — reads `--port` flag or `PLAYGROUND_PORT` env var
- `runPlaygroundHttp` — starts Node HTTP server, embeds Vite dev server via `createViteServer()`
- All API handlers are plain async functions; Effect runtime is used at the top level only
- `PlaygroundServerError` — tagged Data error for server-level failures

### Client (`src/client/`)
- React 19 + Vite 8 + Tailwind CSS v4
- Single-page app, no router — everything in `App.tsx`
- shadcn/ui components under `src/client/components/ui/`
- Path alias `@/*` → `src/client/*`
- Font: Geist Variable via `@fontsource-variable/geist`

#### Key Components
| Component | Purpose |
|---|---|
| `Playground` | Root state container — fetches context, drives selection |
| `ToolInspector` | Left: tool metadata fields. Right: Input/Output/Annotations/Declarations schema viewer |
| `ExecutionPanel` | Code textarea + Run button + result display |
| `Diagnostics` | Shows registry/schema warnings from Code Mode |
| `Metric` | Small stat card (server count, tool count, issue count) |
| `CodeBlock` | Scrollable monospace pre block |
| `Field` / `DescriptionField` | Metadata label+value rows with description expand/collapse |
| `EmptyLine` | Centered empty state with icon |

#### API Calls
```
GET  /api/context           -> { context: CodeModeContext, summary: { serverCount, toolCount, diagnosticCount } }
GET  /api/tool-declarations -> string (TypeScript declarations)
POST /api/execute           -> { result: string } | { error: string }
```

## Files

```
apps/playground/
  src/
    playground.ts                   # HTTP server + Vite + Effect entrypoint
    client/
      main.tsx                      # React root mount
      App.tsx                       # All UI components and state
      styles.css                    # Tailwind v4 theme + base styles
      declarations.d.ts             # vite/client ref + font ambient types
      lib/utils.ts                  # cn() helper
      components/ui/                # shadcn/ui components
  index.html
  vite.config.ts
  tsconfig.json
  package.json
```

## Known Issues / Follow-ups

- No dark mode support (CSS variables defined for light theme only)
- Execution panel has no syntax highlighting in the code textarea
- No persistent state — page refresh resets selected tool and code
- No way to configure execution timeout from the UI
- `pathToFileURL` was missing from `node:url` import — caused `ReferenceError` on startup (fixed)
- tsconfig used `baseUrl` + `NodeNext` moduleResolution (incompatible with Vite) — fixed by switching to `moduleResolution: bundler`
- shadcn `Tabs` component uses `data-horizontal:flex-col` internally which broke the two-panel `ToolInspector` layout — replaced with plain button tab bar

## Verification

```bash
pnpm --filter @ptools/playground typecheck   # 0 errors
EXA_API_KEY=test PTOOLS_CONFIG=./ptools-exa.config.json pnpm playground
```
