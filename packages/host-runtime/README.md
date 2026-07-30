# @ptools/host-runtime

Shared assembly and lifecycle management for configured ptools hosts.

## Mental model

A platform host owns one real Effect `ManagedRuntime` for each host instance.
This package builds the shared services inside that runtime and lazily caches a
configured Effect `Context` for operations that need persisted config, secrets,
auth, MCP connections, and Code Mode.

```txt
Platform-owned host instance
  one ManagedRuntime
    HostStableRuntimeLayer
      HostIdentity + platform storage backends
        shared HostStateStorage.layer / HostSecretStorage.layer
          stable semantic stores
      ConfiguredHostContextRunner
        RcMap keyed by public origin
          configured Context
            ResolvedPtoolsConfigSource
            AuthCoordinator + McpOAuthFlow
            MCP registry
            CodeExecutor + CodeMode
            CodeModeServer
```

There is only one `ManagedRuntime`. A cached configured host context is a scoped
`Context` built with `Layer.build`; it is not a nested runtime.

## What platforms provide

Cloudflare, Node, and future hosts provide only primitive capabilities:

- `HostStateStorageBackend` and `HostSecretStorageBackend`, which can provide
  physical storage for a requested host ID
- `HostIdentity`, stable for the host lifetime
- `McpConnector`, which knows how that platform connects to MCP transports
- `SandboxRuntime`, which knows how that platform executes generated code
- `HostRuntimeBinding` values such as public origin when invoking configured work

This package must not import platform packages. Shared
`HostStateStorage.layer` / `HostSecretStorage.layer` combine
`HostIdentity` with those backend ports and publish final services containing the
selected `hostId` plus exact-key operations. Physical behavior remains
platform-owned: Cloudflare validates that the requested ID is the current Durable
Object; Node derives a per-host directory or keyring prefix. Semantic stores use
logical keys only.

## Main call paths

Configured operation:

```txt
platform RPC/route shell
  -> stableRuntime.runPromise(...)
  -> ConfiguredHostContextRunner.run({ origin }, operation)
  -> cache hit: reuse configured Context
  -> cache miss: build ConfiguredHostContextLayer and cache it
  -> run operation with the cached Context
```

Config or secret replacement:

```txt
stableRuntime
  -> ConfiguredHostConfigStore / ConfiguredSecretStore
  -> ConfiguredHostContextRunner.invalidateAll
  -> next configured operation rebuilds from current persisted values
```

## Source map

- `src/layers/hostStableRuntimeLayer.ts`
  Long-lived graph installed into the platform-owned `ManagedRuntime` once per
  host instance.
- `src/layers/hostStableSharedStoresLayer.ts`
  Host-scoped storage plus stable semantic stores (config, secrets, OAuth).
- `src/services/configuredHostContextRunner.ts`
  Owns the `RcMap`, origin latching, Context leases, and invalidation.
- `src/layers/configuredHostContextLayer.ts`
  Config/origin-derived auth, MCP, executor, Code Mode, and server graph.
- `src/layers/hostAuthCoordinatorPolicyLayer.ts`
  Shared `/hosts/:hostId/...` auth and OAuth URL policy for one configured
  Context.
- `src/errors.ts`
  Context-lifecycle failure boundary (`ConfiguredHostContextError`), distinct
  from operation result errors.

## Ownership boundaries

This package owns cross-package assembly and lifecycle only. Logical config,
secret, and OAuth storage protocols remain in `@ptools/config` and
`@ptools/auth`. MCP behavior remains in `@ptools/mcp-registry`; execution remains
in `@ptools/executor`; platform storage, transport, sandbox, and RPC mechanics
remain in their platform packages.
