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
  ptools/      # this git repo
  planner/     # private planning notes for agents, outside git
  references/  # local reference checkouts for agents, outside git
```

When a task references planner tickets or specs, check `../planner` first. The
planner folder is intentionally private so the repo can become public-safe
later.

For Effect source reference, follow the workspace-level instructions in
`../AGENTS.md`; the local checkout lives at `../references/effect/` when
present.

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
- Prefer functional domain modeling throughout Effect-based code, not only at
  service/layer boundaries:
  - keep domain values immutable and publish complete replacement values rather
    than mutating or partially patching records
  - use `Data.TaggedEnum` for genuine closed state/result variants and use its
    exhaustive `$match` API when projecting or interpreting those variants
  - use `Option` for meaningful internal absence instead of repeatedly passing
    `undefined`; unwrap it explicitly when crossing public JSON, HTTP, RPC, or
    other serialization boundaries
  - keep state-specific data and behavior with the state that owns it instead
    of reconstructing invariants through status checks, conditional spreads,
    and manual field deletion
  - use `SynchronizedRef`/`Ref` to atomically publish newly calculated immutable
    state, not as a container for imperative in-place mutation
- Before introducing custom patch protocols, mutable state machines, manual
  tagged-union switches, or broad uses of `undefined`, inspect
  `../references/effect/` and follow the closest Effect v3 pattern.
- Name Effect services by the boundary they actually represent. Worker ingress
  services should use Worker-specific names and must not be confused with
  Durable Object runtime or Code Mode domain services.
- Source files that own Effect `Context.Tag` service contracts should live under
  `src/services/`. Reserve a package `./effect` export for the public
  Effect-native SDK subpath; it can re-export from `src/services/index.ts` when
  the package intentionally exposes those services to Effect users.
- Keep platform carrier parsing separate from host protocol handling. Platform
  adapters may extract method/path/query/body/header data from HTTP, stdio,
  Workers RPC, or browser callbacks, but reusable host-owned work should be
  represented as a validated `HostOperationDispatchInput`. Caller-side code
  resolves `HostInstanceDiscovery`, dispatches through the selected
  `HostInstanceHandle`, and platform carrier shells delegate receiver-side work
  to `HostInstanceHandler`. Routes should stay thin carrier adapters; do not
  duplicate operation interpretation or result wrapping in route modules.
- Reusable package contracts should live in semantically named files under an
  owning package's `src/contracts/` folder, with a standard `./contracts`
  subpath export for other packages. Keep each file focused on one semantic
  group, e.g. `contracts/mcpAuthStatus.ts`,
  `contracts/authoredPtoolsConfig.ts`, or `contracts/resolvedPtoolsConfig.ts`;
  do not create package-per-DTO sprawl or dump unrelated concepts into one broad
  file. When a package has multiple contract concepts, split them by lifecycle
  or ownership boundary instead of creating one catch-all `contracts/<package>.ts`
  file.
- When refactoring a package surface, check for all three source roles before
  stopping: reusable DTO/schema contracts belong in `src/contracts/`, Effect
  `Context.Tag` services/layers belong in `src/services/`, and runtime behavior
  such as parsing, codecs, hashing, storage, or platform adapters stays in
  semantic behavior files outside those folders. Add or update import-boundary
  tests so these folders and public subpaths do not regress.
- Do not create alias names for the same DTO or concept across package
  boundaries. Keep the owned name everywhere it is used. Add temporary
  compatibility aliases only when explicitly approved.
- Group cohesive domain APIs with the OpenCode-style self-namespace pattern
  when a module owns several closely related schemas, types, constructors, or
  operations:

  ```ts
  // hostTokenPagination.ts
  export * as HostTokenPagination from "./hostTokenPagination.js";
  export const Page = ...;
  export const Cursor = ...;

  // index.ts
  export { HostTokenPagination } from "./hostTokenPagination.js";

  // consumer.ts
  import { HostTokenPagination } from "./hostTokenPagination.js";
  HostTokenPagination.Page;
  ```

  Keep namespace members concise, such as `Page`, `Cursor`, and `makeCursor`.
  Do not substitute default imports, caller-side `import * as` aliases,
  prefixed duplicate member names, or flattened barrel exports that can
  collide. Use this pattern only for a genuinely cohesive domain surface, not
  to wrap every single-export module.

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
- Before changing sandbox-kernel packaging, worker-path resolution, platform
  entrypoint ownership, kernel source artifacts, or Dynamic Worker
  source generation, read
  `docs/sandbox-kernel-platform-artifacts.md`. It records which package owns
  the shared kernel versus each host-specific runnable artifact and the
  accepted Deno/Cloudflare build direction.
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
