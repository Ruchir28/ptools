# @ptools/host-node

`DenoSandboxRuntimeLayer` is the Node implementation of the shared executor
`SandboxRuntime` capability. Layer construction resolves and verifies Deno 2 or
newer using this deterministic order:

```txt
explicit denoExecutable
-> DENO_BIN
-> ~/.deno/bin/deno (or %USERPROFILE%\.deno\bin\deno.exe)
-> deno on PATH
```

Each execution then acquires a fresh subprocess and scopes its cleanup to that
execution. If resolution fails, the startup error explains how to install Deno
or configure an explicit executable.

The process starts with filesystem, network, environment, subprocess, FFI,
system-information, and remote-import permissions explicitly denied. These
permissions are intentionally not configurable through the public API.

The package builds its Deno program loader, stdio bridge, and the shared
`@ptools/executor/sandbox` kernel into one companion
`dist/executor/sandbox-worker.js` file. Runtime code resolves that package-owned
artifact through the private `#sandbox-worker` package mapping; users do not
configure its path. Applications that bundle Node dependencies should keep
`@ptools/host-node` external so the published companion file remains beside the
package runtime.

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
