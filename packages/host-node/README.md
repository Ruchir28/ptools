# @ptools/host-node

Daemon-backed embedded Node hosting for ptools.

## Mental model

```txt
startEmbeddedNodeHost({ hostId })
  -> starts an embedded local Host HTTP listener
  -> listener acquires a lease on the state-namespace daemon
  -> shared HostHttpClient calls the listener
  -> daemon selects the authoritative actor for hostId
```

`hostId` is required. Product entrypoints may explicitly choose `"node-local"`,
but the library does not silently make unrelated embedders share that actor.
Embedded ingress is loopback-only; deploy a separately authenticated Node Host
HTTP server rather than exposing the package's internal local credential.

`internalStateDirectory` selects the application/profile and daemon namespace.
File state and OS-keyring account names are both isolated by that namespace and
`hostId`. Secrets remain in the operating-system keyring; they are not files in
the state directory.

## Explicit initialization

Constructors do not read config files, discover projects, upload ambient process
environment, or warm Code Mode. Initialize through shared Host API operations:

```ts
import { startEmbeddedNodeHost } from "@ptools/host-node";

const host = await startEmbeddedNodeHost({ hostId: "local-main" });

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
  await host.close();
}
```

`createNodeCodeModeClient(options)` is a focused convenience for a host that is
already configured. It performs no initialization or warmup.

Closing the handle closes its embedded ingress and releases that ingress's daemon
lease. It does not directly dispose authoritative actors; another live ingress
lease can continue using the same daemon and actor.

## Existing or remote servers

Do not use `startEmbeddedNodeHost` merely to connect to an existing URL. Use the
shared transport constructor:

```ts
import { createHostHttpClient } from "@ptools/host-api/http";

const host = await createHostHttpClient({
  baseUrl: "https://host.example.com",
  hostId: "main",
  accessToken,
});
```

That handle owns only its local client runtime and sends no remote shutdown
operation when closed.
