# Ticket 4: Cache Code Mode Declaration Fragments At Startup

## Summary

Refactor Code Mode so TypeScript declaration generation happens once when the Code Mode layer starts, not during every filtered `search({ query })`.

Current issue:

```txt
search({ query })
  -> filters tools
  -> calls generateDeclarations(filteredServers)
  -> recompiles schemas for every filtered search
```

Correct shape:

```txt
Code Mode startup
  -> discover MCP tools once
  -> group metadata once
  -> compile declaration fragments once
  -> build providers once

search({ query })
  -> filter metadata
  -> stitch cached declaration fragments
  -> no schema compilation
```

## Key Changes

- Add a declaration index built once during `makeCodeModeLive`.
- Cache per-tool declaration fragments:
  - tool key: `${jsServerName}.${jsToolName}`
  - input type name
  - output type name
  - compiled input declaration block, when valid
  - compiled output declaration block, when valid
  - generated function signature/JSDoc
- Replace `generateDeclarations(filteredServers)` inside `search` with a pure render step over cached fragments.
- Keep blank search precomputed as `fullContext`.
- Keep filtered search returning only matching tools/types/namespaces.
- Do not write declarations to disk.
- Do not compile schemas inside `search`.

## Implementation Notes

- In `declarations.ts`, split current declaration logic into:
  - `buildDeclarationIndex(servers)`:
    - Effect-based.
    - Runs `json-schema-to-typescript.compile(...)`.
    - Called once at layer startup.
  - `renderDeclarations(servers, declarationIndex)`:
    - synchronous/pure.
    - stitches cached type blocks and namespace signatures for the filtered metadata.
- In `context.ts`, make Code Mode runtime include:
  - grouped server metadata
  - executor providers
  - declaration index
  - precomputed full context
- In `CodeMode.ts`, make `search`:
  - blank/missing query: return precomputed full context
  - non-blank query: filter metadata and render declarations from cached fragments

## Tests

- Add a regression test proving filtered search does not recompile schemas:
  - use an injectable schema compiler or test seam in declaration-index building.
  - assert compile runs during startup/index build.
  - call `search({ query: "echo" })` twice.
  - assert compile count does not increase.
- Keep declaration correctness tests:
  - generated function declarations exist.
  - referenced input/output interfaces exist.
  - inner fields are inside the correct interface body.
  - filtered search excludes unmatched tool declarations.
- Keep integration coverage:
  - stdio MCP fixture discovery.
  - `search()` includes `fixture.echo` and `fixture.add`.
  - `search({ query: "echo" })` includes only echo types/functions.
  - `execute` still dispatches through providers backed by `McpRegistry.callTool`.

## Assumptions

- MCP discovery remains startup-scoped in v1.
- Declaration cache lifetime equals Code Mode layer lifetime.
- Future dynamic MCP refresh should rebuild the whole runtime/declaration index explicitly.
- `search` is a selection/rendering operation, not a schema compilation operation.
