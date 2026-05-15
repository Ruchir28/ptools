# Ticket 2: Local Executor And Shared RPC Host

## Summary

Implemented `@ptools/executor` as the local Code Mode execution layer. It runs generated JavaScript in a fresh local Node sandbox process per execution, while provider calls go back to the Code Mode host through a shared localhost HTTP RPC host.

Current request shape:

```ts
execute({
  code,
  globals,
  providers,
  timeoutMs
})
```

Current architecture:

```txt
one Code Mode service instance
  -> one LocalSandboxExecutor
    -> one shared Executor RPC host
      -> many run-scoped entries
```

The executor remains MCP-agnostic. It does not discover MCP tools and does not own MCP clients. Code Mode will create provider handlers from `McpRegistry` and pass them into the executor.

## Executor Implementation

Implemented `packages/executor` as a dev-only local sandbox executor. It is not a production security boundary.

Current behavior:

- starts one shared localhost Executor RPC host per scoped executor instance
- starts one fresh Node sandbox process per execution
- registers each execution as an active run with `runId`, bearer token, provider map, and completion handlers
- passes sandbox only code, serializable globals, provider manifest, callback URL, and token
- exposes provider namespaces as sandbox globals, for example `github.create_issue(...)`
- routes `POST /runs/:runId/call` back to the run's provider handler
- routes `POST /runs/:runId/complete` back to the run's completion handler
- captures `console.log`, `console.warn`, and `console.error`
- returns structured result/logs
- propagates provider failures back to sandbox code
- fails invalid code and uncaught sandbox errors with tagged executor errors
- enforces timeouts and cleans up processes/run entries
- uses Effect for lifecycle, request routing, provider dispatch, and typed errors

Key files:

- `packages/executor/src/LocalSandboxExecutor.ts`
  - scoped executor service
  - per-execution sandbox process lifecycle
  - run registration and timeout handling
- `packages/executor/src/RpcHost.ts`
  - shared localhost HTTP callback server
  - active run map
  - run token validation
  - Effect-based request routing and provider dispatch
- `packages/executor/src/sandbox-worker.ts`
  - generated-code runtime
  - provider stubs
  - callback calls to the RPC host

## Architecture Decisions

- Code Mode host is the running service that owns MCP config, `McpRegistry`, executor layer, credentials, and policy.
- Executor RPC host is a shared callback server owned by the executor, not a registry and not one server per `execute()`.
- Sandbox runtime receives only explicit provider capabilities, not MCP clients or secrets.
- Provider handlers are Effect-returning host capabilities.
- Generated/sandboxed code stays plain JavaScript and does not know Effect.
- Local v1 uses local Code Mode host plus local sandbox process.
- Remote future can use remote Code Mode host plus remote sandbox if the sandbox can reach the callback URL.
- `stdio` MCP servers run wherever the Code Mode host runs.
- User-local stdio MCPs from a remote Code Mode host require a future local bridge/connector.

## Docs And Visuals

Updated:

- `planner/spec.md`
  - current architecture terms
  - executor lifecycle
  - local vs remote deployment model
  - user-local MCP bridge constraint
- `planner/architecture.html`
  - interactive architecture map
  - Local V1 flow
  - Request Trace flow
  - Remote Future view
  - Local MCP From Remote Host view

## Tests Added

Executor tests cover:

- async function execution with serializable globals
- console log capture
- provider namespaces as top-level sandbox globals
- sequential executions through one scoped executor host
- concurrent executions routed to the correct run/provider handlers
- provider result and error propagation over HTTP RPC
- invalid provider/global name failures
- invalid code failure
- uncaught sandbox error propagation
- timeout cleanup
- wrong token rejection
- unknown run rejection
- completed run removal from active run map
- scoped RPC host shutdown

## Verification

Latest successful checks:

```bash
pnpm --filter @ptools/executor test
pnpm --filter @ptools/executor typecheck
pnpm test
pnpm typecheck
pnpm build
```

Latest expected result:

```txt
5 test files passed
24 tests passed
typecheck passed
build passed
```

## Current State

The repo now has the host-mediated execution primitive needed by Code Mode:

```txt
generated JS
  -> provider namespace call
  -> sandbox HTTP callback
  -> shared Executor RPC host
  -> Effect provider handler
  -> future McpRegistry.callTool(...)
```

## Next Ticket Candidate

Implement `packages/code-mode`.

Needed pieces:

- `search({ code })` over safe registry metadata
- `execute({ code })` over provider namespaces backed by `McpRegistry.callTool(...)`
- TypeScript declaration generation for discovered MCP tools
- mapping from sanitized JS names back to original MCP names
- integration test proving a real fixture MCP tool can be called through Code Mode and the local executor
