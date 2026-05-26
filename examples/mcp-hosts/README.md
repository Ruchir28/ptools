# MCP host setup

This example shows the user-facing path for running ptools inside MCP hosts
such as Claude Code and OpenCode.

It is intentionally separate from `examples/mcp-server`, which is a repo-local
smoke fixture. This folder shows the installed-package shape:

```bash
npx -y @ptools/mcp-server --config .ptools/config.json
```

## What This Example Loads

`.ptools/config.json` configures three upstream MCP servers:

- `exa`: a remote HTTP MCP server for web search
- `notion`: a remote HTTP MCP server that uses OAuth
- `sheets`: a remote HTTP MCP server for Google Sheets

When a remote provider needs auth, ptools stays connected and prints an auth
center URL:

```txt
[ptools] Auth center: http://127.0.0.1:<port>/auth
```

Open that URL, authorize the provider, then ask the host agent to call
`refresh` or search again.

## OpenCode Side-By-Side

This folder includes two OpenCode configs for comparing the same providers
through ptools versus loading every MCP server directly:

- `opencode.ptools.json`: OpenCode loads one `ptools` MCP server.
- `opencode.direct.json`: OpenCode loads `exa`, `notion`, and `sheets`
  directly.

Run the ptools version in one terminal:

```bash
cd examples/mcp-hosts
OPENCODE_CONFIG="$PWD/opencode.ptools.json" opencode
```

Run the direct-MCP version in another terminal:

```bash
cd examples/mcp-hosts
OPENCODE_CONFIG="$PWD/opencode.direct.json" opencode
```

Ask the ptools session:

```txt
Use the ptools MCP server. Show me the configured providers, then search for
spreadsheet tools, web search tools, and Notion tools. If anything needs auth,
tell me the auth URL.
```

Ask the direct-MCP session:

```txt
Show me the loaded MCP providers and available spreadsheet, web search, and
Notion tools. If anything needs auth, tell me how to authorize it.
```

The ptools config starts only one MCP server from OpenCode's point of view:

```json
{
  "mcp": {
    "ptools": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@ptools/mcp-server",
        "--config",
        "./.ptools/config.json"
      ],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

The direct config exposes each upstream MCP server to OpenCode separately:

```json
{
  "mcp": {
    "exa": {
      "type": "remote",
      "url": "https://mcp.exa.ai/mcp"
    },
    "notion": {
      "type": "remote",
      "url": "https://mcp.notion.com/mcp"
    },
    "sheets": {
      "type": "remote",
      "url": "https://mcp.gumloop.com/gsheets/mcp"
    }
  }
}
```

## Claude Code

Claude Code can use the checked-in `.mcp.json` from this folder. This is the
same shape users should add to their own project:

```json
{
  "mcpServers": {
    "ptools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@ptools/mcp-server",
        "--config",
        ".ptools/config.json"
      ]
    }
  }
}
```

Run Claude Code from this directory:

```bash
cd examples/mcp-hosts
claude
```

Then ask:

```txt
Use the ptools MCP server. Call auth_status, then search for spreadsheet,
web search, and Notion actions. If anything needs authorization, give me the
auth center URL.
```

You can also add ptools with the Claude Code CLI instead of using `.mcp.json`:

```bash
cd examples/mcp-hosts
claude mcp add ptools --scope project -- npx -y @ptools/mcp-server --config "$PWD/.ptools/config.json"
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
Use `search_providers` when you need to discover which upstream provider owns a
task. Use `execute` for multi-step calls and for reducing large/intermediate
provider results before returning the final answer.

## Source Checkout Variant

When developing from this repository instead of using the npm package, use the
repo-local command from this example directory:

```bash
pnpm --dir ../.. --filter @ptools/mcp-server... build
pnpm --dir ../.. --filter @ptools/mcp-server dev -- --config "$PWD/.ptools/config.json"
```

For host config while developing from source, point the host at `pnpm` directly:

```json
{
  "command": [
    "pnpm",
    "--dir",
    "/absolute/path/to/ptools",
    "--filter",
    "@ptools/mcp-server",
    "dev",
    "--",
    "--config",
    "/absolute/path/to/project/.ptools/config.json"
  ]
}
```

For public docs and users, prefer the installed-package `npx` command.
