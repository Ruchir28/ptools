# Agent Instructions

## Project Direction

This repo is MCP-first. Do not drift into a generic tool runner, generic fake tools package, or app-host-first architecture.

The product goal is:

```txt
many upstream MCP servers
  -> one combined Code Mode MCP server
  -> exposes search + execute
  -> generated code calls provider APIs like github.createIssue(...)
  -> host dispatches back to the original upstream MCP tools
```

The sandbox/executor is a code execution detail. The authoritative layer is always the host-side MCP registry and dispatcher.

## Current Repo Shape

- `packages/mcp-registry`: owns upstream MCP client connections, discovery, name sanitization, and dispatch.
- `packages/code-mode`: reserved for search/execute orchestration over registry metadata and runtime proxies.
- `packages/executor`: reserved for configurable code execution implementations.
- `packages/mcp-server`: publishable combined MCP server package and CLI entrypoint.
- Private planning docs live outside the git repo at `../planner` when this
  checkout is under `ptools-project/ptools`. Use those docs for agent planning,
  but do not move them back into the repo or treat them as public artifacts.

## Local Project Layout

The preferred local layout is:

```txt
ptools-project/
  ptools/   # this git repo
  planner/  # private planning notes for agents, outside git
```

When a task references planner tickets or specs, check `../planner` first. The
planner folder is intentionally private so the repo can become public-safe
later.

## Implementation Rules

- Keep implementation MCP-first:
  - connect upstream MCP servers with the official MCP SDK
  - discover tools through `listTools`
  - dispatch through `callTool`
  - preserve original MCP tool names internally
  - expose sanitized JS names only at the generated-code boundary
- This repo uses Effect-TS for host/runtime code. Use Effect for services, async orchestration, resource lifetimes, and typed errors.
- Prefer Effect-native composition patterns for host/runtime code: model
  capabilities with `Context.Tag`, provide implementations with `Layer`, and
  read dependencies from the Effect environment instead of threading broad
  parameter bags through multiple functions.
- Name Effect services by the boundary they actually represent. Worker ingress
  services should use Worker-specific names and must not be confused with
  Durable Object runtime or Code Mode domain services.
- If Effect is not viable for a host/runtime change, stop and confirm the
  non-Effect implementation direction with the user before proceeding.
- Executor provider handlers are Effect-returning host capabilities. Wrap promise/value work with `Effect.promise` or `Effect.succeed` instead of widening executor APIs to raw promises.
- Keep generated/sandboxed code plain JavaScript. Do not require generated code to know Effect.
- Prefer fail-fast behavior for schema, name mapping, and dispatch invariants.
- Do not add quiet fallbacks for critical mapping failures.
- Do not hide MCP contract errors with permissive UI/runtime guards.
- Keep `unknown` at external MCP boundaries unless a runtime schema has validated the value.

## Testing Expectations

Before considering registry changes complete, run:

```bash
pnpm --filter @ptools/mcp-registry test
pnpm typecheck
pnpm build
```

The registry has both unit tests and a real stdio MCP integration test. Preserve both styles:

- Unit tests cover name mapping, discovery conversion, and dispatch routing.
- Integration tests prove real MCP stdio wiring with a fixture server.

When adding Code Mode or executor behavior, add tests that prove the actual vertical slice, not only helper functions.

## Search And Docs

- Prefer local repo inspection before theorizing.
- For MCP SDK usage, check installed SDK types/examples first.
- If web research is needed, use configured search tools before built-in browsing.
- For research-heavy comparisons or open-ended architecture questions, spawn
  focused subagents for independent research tracks and read their summarized
  findings instead of doing all research in the main thread. Keep the main
  thread for synthesis, decisions, and implementation. Use smaller/cheaper
  agents when the task only needs bounded documentation or codebase research.

## Style

- Keep packages small and boring.
- Avoid premature abstractions.
- Do not add a CLI or UI unless explicitly requested.
- Use workspace package imports instead of path aliases.
- Keep docs and specs updated when architectural decisions change.
