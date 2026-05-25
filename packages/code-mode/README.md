# @p_tools/code-mode

Internal runtime building block for ptools packages.

This package owns Code Mode search, schema lookup, and execute orchestration
over the host-side MCP registry and executor services.

Discovery is intentionally split:

- `search_providers` returns provider namespaces only.
- `search` returns callable action candidates only and requires task/action
  terms.
- `get_tool_schema` loads full schemas and declarations for selected `toolId`s.

Action search treats provider words as context, not action intent. For example,
`search({ query: "github issue" })` may use `github` to narrow/boost and
`issue` to match action metadata. `search({ query: "github" })` should not list
every GitHub action; use `search_providers({ query: "github" })` first, then
search with a task-specific action query such as
`search({ provider: "github", query: "issue" })`.

For the alpha user guide, install and use `@p_tools/agent-tools`.
