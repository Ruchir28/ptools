# @ptools/cli

Command-line composition surface for ptools.

The CLI owns host selection and adapter wiring. Adapter packages such as
`@ptools/mcp-server` remain host-neutral; host packages such as
`@ptools/host-node` create Code Mode clients.

```bash
npx -y @ptools/cli mcp serve --host node --config ./ptools.config.json
```

The Node host supports normal config discovery when `--config` is omitted:

```bash
ptools mcp serve --host node
```
