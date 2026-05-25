# MCP server example

This example shows how to run the publishable `@ptools/mcp-server` package.
It starts `ptools-mcp` without passing `--config`; ptools discovers
`.ptools/config.json` from the example package directory by default. That config
connects one local upstream MCP server named `echo`, which exposes simple
echo/math tools plus a small product inventory and quoting workflow.

For user-facing Claude Code and OpenCode setup, use `examples/mcp-hosts`
instead. This folder is mainly a repo-local smoke fixture.

## Run an end-to-end smoke

From the repo root:

```bash
pnpm --filter @ptools/example-mcp-server smoke
```

The smoke client starts `ptools-mcp` over stdio, lists the public Code Mode
tools, searches the local `echo` provider, fetches schemas for inventory and
quote tools, and executes a generated JavaScript workflow through Code Mode:

1. list in-stock products
2. load wholesale customer terms
3. check inventory for requested line items
4. adjust unavailable quantities
5. create a discounted quote

## Use from OpenCode

This folder includes an `opencode.json` project config. It registers the
publishable ptools MCP server as one local MCP server named `ptools`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ptools": {
      "type": "local",
      "command": [
        "pnpm",
        "--dir",
        "../..",
        "--filter",
        "@ptools/example-mcp-server",
        "start"
      ],
      "enabled": true,
      "timeout": 10000
    }
  }
}
```

OpenCode runs the example package's `start` script. For local development, that
script first builds the repo TypeScript project so `ptools-mcp` sees fresh
workspace package changes, then runs `ptools-mcp` with no config argument. The
config is found through the default lookup at
`examples/mcp-server/.ptools/config.json`.

Then start OpenCode from this example directory:

```bash
cd examples/mcp-server
opencode
```

Try a prompt like:

```txt
Use the ptools MCP server. Find the product and quote tools, inspect their
schemas, then create a wholesale quote for cust-001 with 6 Assam tea, 3 Arabica
coffee, and 8 cardamom biscuits. Adjust quantities if inventory is short.
```

The agent should see these public ptools tools:

- `auth_status`
- `execute`
- `get_tool_schema`
- `refresh`
- `search_providers`
- `search`

The expected workflow is to call `search`, then `get_tool_schema`, then
`execute` generated JavaScript that calls provider APIs like
`echo.list_products(...)`, `echo.check_inventory(...)`, and
`echo.create_quote(...)`.

## Use from another MCP host

Any MCP client that can run a local stdio server can use the same command. In a
client that accepts a command-plus-args array, point it at the example package:

```json
{
  "command": "pnpm",
  "args": [
    "--dir",
    "/absolute/path/to/ptools",
    "--filter",
    "@ptools/example-mcp-server",
    "start"
  ]
}
```

For an installed package, point the MCP host directly at `ptools-mcp`. If the
host launches the server from the directory that contains `.ptools/config.json`,
no args are needed:

```json
{
  "command": "ptools-mcp",
  "args": []
}
```

Pass `--config` only when the host starts `ptools-mcp` from another working
directory or the config lives somewhere else:

```json
{
  "command": "ptools-mcp",
  "args": [
    "--config",
    "/absolute/path/to/ptools/examples/mcp-server/.ptools/config.json"
  ]
}
```

In that installed-package form, make sure the upstream commands referenced by
`.ptools/config.json` are available on the host machine. This example uses
`tsx`, so the repo-local `pnpm --filter @ptools/example-mcp-server start` route
is the most reliable way to test it while developing ptools itself.

## Run the MCP server directly

From the repo root:

```bash
pnpm --filter @ptools/example-mcp-server start
```

This launches the MCP server on stdio. It is meant to be started by an MCP host
or client, so a plain terminal run will wait for MCP messages on stdin.

The command above is equivalent to running this from `examples/mcp-server`:

```bash
ptools-mcp
```

## Config

`.ptools/config.json` uses the normal ptools MCP config shape:

```json
{
  "mcpServers": {
    "echo": {
      "command": "tsx",
      "args": ["src/echo-mcp-server.ts"],
      "cwd": ".."
    }
  }
}
```

The relative `cwd` resolves from this config file's directory. Because the
config lives in `.ptools/`, `"cwd": ".."` starts the upstream fixture inside
`examples/mcp-server`.

There is no path adjustment needed for ptools to find the config itself. The
only relative path here is the upstream server `cwd`, which tells the local
`echo` server where to run from after ptools has loaded the config.
