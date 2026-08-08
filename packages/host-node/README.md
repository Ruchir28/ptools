# @ptools/host-node

Named, explicitly started local Node deployments for ptools.

## Mental model

```txt
Terminal A
  ptools node deployment start default
    -> creates the conventional descriptor if missing
    -> owns the control-plane lock and fixed loopback listener in foreground
    -> owns one private actor-daemon connection/lease
    -> stays alive until Ctrl-C or process-supervisor interruption

Application / Terminal B
  connectLocalNodeHost({ deploymentName: "default", hostId })
    -> resolves the existing deployment descriptor
    -> maps the descriptor's fixed port to its canonical origin
    -> returns an ordinary HTTP client without a network preflight
    -> never starts, retains, or stops the server
```

The default deployment uses `http://127.0.0.1:19876`. Its state root is
`~/.ptools/node-deployments/default/state`, or the equivalent under
`PTOOLS_HOME`.

## Deployment lifecycle

Run the deployment in a dedicated terminal:

```sh
ptools node deployment start default
```

Additional deployments are created explicitly:

```sh
ptools node deployment create work --port 19877
ptools node deployment start work
ptools node deployment list
```

`start` remains in the foreground. Ordinary clients do not implicitly start the
process and their `close()` methods never stop it; use Ctrl-C in the owning
terminal to shut the deployment down.

## Explicit initialization

After starting the deployment, initialize a selected host through ordinary Host
API operations:

```ts
import { connectLocalNodeHost } from "@ptools/host-node";

const host = await connectLocalNodeHost({ hostId: "local-main" });
try {
  await host.call({
    operation: "configure",
    input: { config: authoredConfig },
  });
  await host.call({
    operation: "configure_secrets",
    input: { secrets: explicitlySelectedSecrets },
  });
  await host.codeMode.call(request);
} finally {
  await host.close(); // closes only this HTTP client/runtime
}
```

`createNodeCodeModeClient(options)` is also connect-only and exposes just the
focused Code Mode handle.

## Explicit URL connections

Use the platform-neutral constructor when the URL is already known:

```ts
import { createHostHttpClient } from "@ptools/host-api/http";

const host = await createHostHttpClient({
  baseUrl: "https://host.example.com",
  hostId: "main",
  accessToken,
});
```

This path performs no catalog lookup or lifecycle operation. The target server
must already be running.
