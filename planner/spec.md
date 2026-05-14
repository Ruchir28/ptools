# ptools Project Spec

## Summary

`ptools` wraps multiple upstream MCP servers into one combined Code Mode MCP server. The combined server exposes a small discovery/execution surface, while the host keeps authority over MCP clients, credentials, policy, and dispatch.

The intended external surface is:

```txt
search({ code })
execute({ code })
```

Generated code should call grouped APIs:

```ts
async () => {
  const issue = await mcp.github.createIssue({
    owner: "example",
    repo: "repo",
    title: "Example"
  });

  return issue;
}
```

At runtime, `mcp.github.createIssue` is a host-backed proxy. It dispatches to the original upstream MCP server/tool.

## Architecture

The system has three authority zones:

```txt
Combined MCP server
  - exposes search + execute to MCP clients
  - owns the public wrapper protocol

Host runtime
  - connects to upstream MCP servers
  - owns credentials and process/session lifetimes
  - discovers tool schemas
  - validates names and dispatches calls
  - applies policy and error handling

Code executor
  - runs generated JavaScript
  - receives only safe bindings such as metadata or mcp proxy
  - does not receive raw MCP clients, config, env, or secrets
```

## Packages

### `packages/mcp-registry`

Owns upstream MCP integration.

Responsibilities:

- load upstream server config passed by caller
- connect stdio and Streamable HTTP MCP clients
- discover all tools, including paginated `listTools`
- sanitize MCP server/tool names into JavaScript identifiers
- fail on name collisions
- dispatch JS-facing calls back to original MCP tool names
- close MCP clients through Effect scoped lifetimes

Current key API:

```ts
makeMcpRegistryLive(upstreams)
McpRegistry.listTools
McpRegistry.callTool
```

This package is implemented and covered by unit tests plus a real stdio MCP integration test.

### `packages/executor`

Reserved for configurable code execution.

Initial implementation should be a dev-only Node executor. It is not a production security boundary.

Expected shape:

```ts
run({
  code,
  bindings,
  timeoutMs
})
```

Later executor implementations can target a remote sandbox, Cloudflare Worker isolate, container, or another runtime without changing Code Mode or MCP registry APIs.

### `packages/code-mode`

Reserved for Code Mode orchestration.

Responsibilities:

- implement `search` over safe tool metadata
- implement `execute` over an `mcp` runtime proxy
- generate model-facing TypeScript declarations from discovered MCP tools
- keep generated code plain JavaScript
- never expose raw MCP clients or secrets to the executor

### `apps/server`

Reserved for the combined MCP server entrypoint.

Responsibilities:

- load project config
- construct Effect layers
- create the combined MCP server
- register `search` and `execute`
- connect the combined server to stdio first

## Search And Execute Semantics

### `search`

`search` runs generated JavaScript against metadata only.

Allowed binding:

```ts
api.servers[]
```

The metadata should include server names, tool names, descriptions, input schemas, output schemas when available, and annotations.

`search` must not expose live MCP clients.

### `execute`

`execute` runs generated JavaScript against a grouped `mcp` proxy.

Allowed binding:

```ts
mcp.<server>.<tool>(arguments)
```

The proxy maps sanitized JS names back to original MCP server/tool names and calls `McpRegistry.callTool`.

Invalid server/tool names should fail loudly.

## Naming Rules

MCP names can contain characters that are not legal JavaScript identifiers. The host sanitizes names for generated code and preserves reverse mappings.

Examples:

```txt
create-issue -> create_issue
github.createIssue -> github_createIssue
delete -> delete_
3d-render -> _d_render
```

If two names sanitize to the same identifier, startup/discovery should fail. Do not silently rename or suffix critical API names.

## Error And Type Policy

External MCP boundaries should use `unknown` until runtime validation has occurred. This is intentional because MCP schemas are discovered at runtime.

Use Effect tagged errors for host-side failures:

- connection failures
- discovery failures
- name collisions
- missing tools
- invalid tool arguments
- upstream MCP call failures
- executor failures

Generated TypeScript declarations are for the model. They do not make upstream MCP data compile-time safe inside the host.

## Testing

Current registry checks:

```bash
pnpm --filter @ptools/mcp-registry test
pnpm typecheck
pnpm build
```

Existing registry test coverage:

- JS name sanitization
- name collision failure
- missing mapped name failure
- paginated tool discovery across clients
- dispatch to original MCP tool names
- invalid argument rejection
- real stdio MCP fixture server integration

Next packages should follow the same pattern:

- unit tests for helpers and failure behavior
- integration tests for the real host-mediated path

## Near-Term Implementation Plan

1. Keep `mcp-registry` stable unless Code Mode reveals an ergonomic issue.
2. Implement `packages/executor` with a dev-only Node runner and timeout/log capture.
3. Implement `packages/code-mode` search over registry metadata.
4. Implement `packages/code-mode` execute with an `mcp` proxy backed by `McpRegistry.callTool`.
5. Implement `apps/server` as the stdio combined MCP server exposing `search` and `execute`.

## Non-Goals For V1

- No CLI product.
- No web UI.
- No production sandbox guarantee from the first Node executor.
- No direct exposure of upstream MCP tools as individual wrapper tools.
- No generic fake-tool framework as the core abstraction.

Fake or in-memory tools are allowed only as test doubles. The product abstraction is MCP server composition.
