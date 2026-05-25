# MCP host setup

This example shows the user-facing path for running ptools inside MCP hosts
such as Claude Code and OpenCode.

It is intentionally separate from `examples/mcp-server`, which is a repo-local
smoke fixture. This folder shows the installed-package shape:

```bash
npx -y @p_tools/mcp-server --config ./.ptools/config.json
```

## What This Example Loads

`.ptools/config.json` configures two upstream MCP servers:

- `exa`: a local stdio MCP server that uses `EXA_API_KEY`
- `notion`: a remote HTTP MCP server that uses OAuth

Set your Exa key before starting the host:

```bash
export EXA_API_KEY=...
```

When Notion needs auth, ptools stays connected and prints an auth center URL:

```txt
[ptools] Auth center: http://127.0.0.1:<port>/auth
```

Open that URL, authorize Notion, then ask the host agent to call `refresh` or
search again.

## OpenCode

This folder includes `opencode.json`.

Run OpenCode from this directory:

```bash
cd examples/mcp-hosts
opencode
```

Then ask:

```txt
Use the ptools MCP server. Show me the configured providers, then search for
web search tools and Notion tools. If anything needs auth, tell me the auth URL.
```

OpenCode should start ptools with:

```json
{
  "mcp": {
    "ptools": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@p_tools/mcp-server",
        "--config",
        "./.ptools/config.json"
      ],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

## Claude Code

Claude Code can use the checked-in `.mcp.json` from this folder. It starts
ptools through `npx` and points ptools at this example's `.ptools/config.json`
using Claude Code's `CLAUDE_PROJECT_DIR` environment variable.

Run Claude Code from this directory:

```bash
cd examples/mcp-hosts
claude
```

Then ask:

```txt
Use the ptools MCP server. Call auth_status, then search for web search and
Notion actions. If Notion needs authorization, give me the auth center URL.
```

You can also add ptools with the Claude Code CLI instead of using `.mcp.json`:

```bash
cd examples/mcp-hosts
claude mcp add ptools --scope project -- npx -y @p_tools/mcp-server --config "$PWD/.ptools/config.json"
```

Use `--scope user` instead of `--scope project` if you want the entry available
outside this folder.

## Expected ptools Tools

The host sees only ptools' stable tool surface:

- `auth_status`
- `refresh`
- `search_providers`
- `search`
- `get_tool_schema`
- `execute`

The upstream provider tools are discovered through `search` and executed through
generated JavaScript passed to `execute`.

## Source Checkout Variant

Before `@p_tools/mcp-server` is published, use the repo-local command from this
example directory instead of `npx`:

```bash
pnpm --dir ../.. --filter @p_tools/mcp-server... build
pnpm --dir ../.. --filter @p_tools/mcp-server dev -- --config "$PWD/.ptools/config.json"
```

For host config while developing from source, point the host at a shell command:

```json
{
  "command": [
    "sh",
    "-lc",
    "cd ../.. && pnpm --filter @p_tools/mcp-server dev -- --config \"$OLDPWD/.ptools/config.json\""
  ]
}
```

For public docs and users, prefer the installed-package `npx` command.
