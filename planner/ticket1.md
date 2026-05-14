# Ticket 1: MCP Registry Foundation And Project Setup

## Summary

Set up `ptools` as an MCP-first TypeScript monorepo and implemented the first real foundation package: `@ptools/mcp-registry`.

The project direction is a Cloudflare-style Code Mode MCP wrapper:

```txt
many upstream MCP servers
  -> one combined MCP server
  -> exposes search + execute
  -> generated code calls mcp.<server>.<tool>(...)
  -> host dispatches to original upstream MCP tools
```

## Repo Setup

- Initialized pnpm workspace with NodeNext TypeScript project references.
- Added packages:
  - `apps/server`
  - `packages/core`
  - `packages/mcp-registry`
  - `packages/executor`
  - `packages/code-mode`
- Added root scripts:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
- Added dependencies:
  - `effect`
  - `@modelcontextprotocol/sdk`
  - `zod` in `@ptools/mcp-registry`
  - TypeScript/Vitest/tsx/prettier toolchain
- Added `.gitignore` for dependency/build artifacts.

## MCP Registry Implementation

Implemented `packages/mcp-registry` as the host-side authority over upstream MCP servers.

Current behavior:

- Connects configured upstream MCP servers.
- Supports stdio MCP clients.
- Supports Streamable HTTP MCP clients.
- Discovers all tools from each upstream server.
- Handles paginated `listTools` via `nextCursor`.
- Sanitizes MCP server/tool names into JavaScript-safe identifiers.
- Preserves original MCP server/tool names for dispatch.
- Fails on name collisions instead of silently renaming.
- Dispatches JS-facing calls back to original MCP `callTool`.
- Uses Effect services, scoped lifetimes, and tagged errors.

Key files:

- `packages/mcp-registry/src/connect.ts`
  - `connectConfiguredMcpClients`
  - `closeClients`
- `packages/mcp-registry/src/discovery.ts`
  - `discoverAllTools`
- `packages/mcp-registry/src/dispatch.ts`
  - `dispatchToolCall`
- `packages/mcp-registry/src/names.ts`
  - `sanitizeJsIdentifier`
  - `buildNameMap`
  - `getMappedName`
- `packages/mcp-registry/src/McpRegistryLive.ts`
  - `makeMcpRegistryLive`

## Tests Added

Added unit tests for:

- JS name sanitization.
- name collision failures.
- missing mapped-name failures.
- paginated discovery across multiple fake MCP clients.
- dispatch from JS-facing names to original MCP tool names.
- invalid argument rejection.

Added real integration test:

- Fixture server: `packages/mcp-registry/test/fixtures/stdio-mcp-server.ts`
- Integration test: `packages/mcp-registry/test/mcp-registry.integration.test.ts`
- Fixture exposes:
  - `echo`
  - `add`
- Test proves:
  - registry connects to a real stdio MCP process
  - `listTools` discovers real MCP tools
  - `callTool` dispatches to the fixture server
  - scoped lifecycle closes the client/server connection

## Docs Added

- `AGENTS.md`
  - repo instructions for future agents
  - MCP-first architecture guardrails
  - Effect/testing expectations
- `planner/spec.md`
  - project-wide architecture spec
  - package responsibilities
  - search/execute semantics
  - naming/error/type policy
  - near-term implementation plan

## Verification

Latest successful checks:

```bash
pnpm --filter @ptools/mcp-registry test
pnpm test
pnpm typecheck
pnpm build
```

Expected result:

```txt
4 test files passed
9 tests passed
typecheck passed
build passed
```

## Current State

`mcp-registry` is ready enough to build the next layer on top of it.

The package now provides the core host-side primitive needed by Code Mode:

```txt
MCP config
  -> connected clients
  -> discovered metadata
  -> sanitized JS names
  -> original MCP dispatch
```

## Next Ticket Candidate

Implement `packages/executor` with a dev-only Node executor.

Needed for:

- `search({ code })` running against safe metadata
- `execute({ code })` running against an `mcp` proxy

Initial executor should:

- accept a code string
- inject safe bindings
- require an async function shape
- capture console logs
- enforce a timeout
- return structured result/error/logs
- be clearly marked as dev-only, not a production sandbox
