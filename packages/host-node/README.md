# @ptools/host-node

Node host adapters for ptools.

This package owns local Node config loading, environment-secret resolution,
keyring-backed OAuth credentials, local MCP registry construction, local code
execution, and Code Mode client/server assembly.

```ts
import { createNodeCodeModeClientFromConfigFile } from "@ptools/host-node";

const client = await createNodeCodeModeClientFromConfigFile(
  "./ptools.config.json",
);

try {
  const providers = await client.call({
    operation: "search_providers",
    input: {},
  });
  console.log(providers.output.providers);
} finally {
  await client.close();
}
```
