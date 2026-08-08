# @ptools/cli

Command-line composition surface for ptools.

The Effect-native CLI owns command parsing, host selection, authored-file
bootstrap, and adapter wiring. It uses `effect/unstable/cli` for commands and
options. The foreground `node deployment start` command owns the server scope;
MCP commands are connect-only clients. Adapter packages such as
`@ptools/mcp-server` remain host-neutral; host packages such as
`@ptools/host-node` receive explicit configuration values and never discover
files or environment variables.

Run the named local deployment in a dedicated terminal:

```bash
npx -y @ptools/cli node deployment start default
```

Then connect the MCP-facing command from another process:

```bash
npx -y @ptools/cli mcp serve --host node --host-id my-project --config ./ptools.config.json
```

`--host-id` selects the logical actor inside the Node state namespace. Omit it
only when intentionally using the conventional personal `"node-local"` actor.
Use distinct IDs for projects that may run concurrently.

When `--config` is omitted, the CLI—not the Node host—selects
`.ptools/config.json` or `ptools.config.json` from its working directory. It then
decodes the file, resolves only referenced `${env:NAME}` values, and submits
explicit `configure` and `configure_secrets` Host API operations:

```bash
ptools mcp serve --host node
```
