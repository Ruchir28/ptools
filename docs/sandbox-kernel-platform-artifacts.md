# Sandbox Kernel And Platform Artifact Ownership

Status: accepted architecture direction. Executor and host-node migration
implemented; host-cloudflare implementation remains future work.

Last reviewed: 2026-06-19.

Related planning:

- `../../planner/ticket17-e-2.md`
- `../../planner/ticket17-e-2.1.md`
- `../../planner/ticket17-e.md`

## Purpose

This document records how the shared sandbox kernel, platform-specific sandbox
entrypoints, and their built runtime artifacts should be owned and packaged.

It answers these recurring questions:

- Why does the Deno sandbox worker contain both host-node and executor code?
- Why is the Deno program loader not part of the shared kernel?
- Does Cloudflare need a separately published kernel source string?
- Which package should build and ship each sandbox artifact?
- How should host-node locate its worker without inspecting `.ts` versus `.js`
  filenames at runtime?

The central decision is:

> `@ptools/executor` owns the platform-neutral kernel module. Each platform host
> owns its adapter entrypoint and builds the kernel into the final artifact that
> its platform can execute.

## The Three Runtime Boundaries

The executor architecture contains three different concerns:

| Concern                     | Trust and dependency context                                               | Owner                                             |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Host orchestration          | Trusted Effect runtime, timeouts, provider dispatch, resource lifetime     | `@ptools/executor` plus the selected host package |
| Wire contracts              | Transport-neutral messages and schemas crossing process/isolate boundaries | `@ptools/executor`                                |
| Sandbox kernel              | Dependency-free execution engine running with untrusted generated code     | `@ptools/executor/sandbox`                        |
| Platform sandbox entrypoint | Program loading plus platform transport bridge                             | The platform host package                         |
| Final runnable artifact     | File or source text consumed by that platform                              | The platform host package                         |

The shared kernel does not know how code is loaded, how messages cross the
boundary, or how the sandbox is created. It receives two already-composed
things:

1. a `SandboxProgram` loaded by the platform entrypoint;
2. a required `SandboxHostBridge` implemented by that platform.

That division keeps the kernel reusable without pretending that process and
isolate construction are identical across platforms.

## Shared Kernel Ownership

`packages/executor/src/sandbox/kernel/` owns:

- provider namespace construction;
- captured console injection;
- provider-call tracking and correlation validation;
- error serialization/deserialization;
- execution of an already-loaded `SandboxProgram`;
- construction of the final `SandboxCompletion` envelope.

It deliberately does not own:

- `new Function(...)` or another platform program loader;
- Deno standard-input/standard-output framing;
- Cloudflare Workers RPC bindings;
- subprocess spawning;
- Dynamic Worker Loader calls;
- host-side Effect services, scopes, or timeouts.

The kernel is exported as executable JavaScript through:

```ts
import { makeSandboxKernel } from "@ptools/executor/sandbox";
```

This module export is the reusable source of truth. Platform hosts import it at
build time and include it in their own sandbox artifact.

Executor publishes the kernel as ordinary modular TypeScript output. It does
not pre-bundle or serialize the implementation:

```txt
packages/executor/src/sandbox/index.ts
  -> tsc
  -> packages/executor/dist/sandbox/index.js
     -> ./kernel/index.js
        -> ./kernel/kernel.js
```

The `@ptools/executor/sandbox` export points at that normal module graph. A host
bundler follows the graph when it builds the final platform artifact. This
avoids compiling the kernel into one file in executor and then bundling that
file a second time in a host package.

## Host-Node And Deno

### Source ownership

`packages/host-node/src/executor/sandbox-worker.ts` owns the Deno-specific
sandbox entrypoint. It contains:

- the Deno `stdin`/`stdout` NDJSON message loop;
- the pending-Promise table used by the stdio bridge;
- the Deno `SandboxHostBridge` implementation;
- the Deno-specific `loadDenoSandboxProgram(...)` function;
- initialization of the imported shared kernel.

The program loader is defined directly in this entrypoint. It is not imported
from executor:

```ts
function loadDenoSandboxProgram(
  payload: SandboxExecutionPayload,
): SandboxProgram {
  const names = injectableBindingKeys(payload.globals, payload.providers);

  return new Function(
    "__bindings",
    `const { ${names.join(", ")} } = __bindings; return (${payload.code})();`,
  ) as SandboxProgram;
}
```

This belongs to host-node because runtime compilation behavior is part of the
Deno adapter. Another sandbox may load a module, call an RPC entrypoint, use a
platform loader, or reject runtime compilation entirely.

### Build flow

The host-node worker build uses `sandbox-worker.ts` as its esbuild entrypoint
with `bundle: true`:

```txt
packages/host-node/src/executor/sandbox-worker.ts
  + @ptools/executor/sandbox
  + transport DTO code required by the worker
  -> esbuild
  -> packages/host-node/dist/executor/sandbox-worker.js
```

The resulting file is self-contained. At runtime, Deno does not resolve or
load `@ptools/executor`; the shared kernel has already been bundled into the
host-node-owned worker file.

This gives the final artifact one clear owner:

| Item                         | Owner               |
| ---------------------------- | ------------------- |
| Shared kernel implementation | `@ptools/executor`  |
| Deno loader and stdio bridge | `@ptools/host-node` |
| Bundled `sandbox-worker.js`  | `@ptools/host-node` |
| Worker-path resolution       | `@ptools/host-node` |

### Worker-path resolution

The previous resolver distinguished source execution from compiled execution by
checking whether `import.meta.url` ends with `.ts`. That works, but it makes
runtime code understand both the source tree and the build tree:

```ts
const resolveWorkerPath = (): string =>
  import.meta.url.endsWith(".ts")
    ? fileURLToPath(
        new URL("../../dist/executor/sandbox-worker.js", import.meta.url),
      )
    : fileURLToPath(new URL("./sandbox-worker.js", import.meta.url));
```

Host-node now uses a private package import mapping in
`packages/host-node/package.json`:

```json
{
  "imports": {
    "#sandbox-worker": "./dist/executor/sandbox-worker.js"
  }
}
```

Then source tests and published JavaScript resolve the same explicit build
artifact:

```ts
const resolveWorkerPath = (): string =>
  fileURLToPath(import.meta.resolve("#sandbox-worker"));
```

This is appropriate because:

- the repository requires Node.js 22 or newer;
- package `imports` mappings are private to code inside the package;
- users do not need to configure or know the worker path;
- tests already build the worker before running the Deno integration suite;
- the mapping states artifact ownership in the package manifest;
- no fallback search over possible filesystem layouts is required.

The packed-artifact check must verify that the mapping target is present in the
npm tarball.

## Host-Cloudflare And Dynamic Workers

### Why Cloudflare receives source text

Cloudflare Dynamic Workers do not start from a local filesystem path. The
Worker Loader receives a `WorkerCode` object containing a `mainModule` and a
map of module names to JavaScript source strings or typed module objects.
TypeScript must be compiled before the code is supplied to the Loader.

Current documentation:

- [Dynamic Workers getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)
- [Worker Loader API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)

This changes the delivery format, not the ownership model.

### Target build flow

Host-cloudflare should own a fixed Dynamic Worker entrypoint containing:

- the Cloudflare program loader;
- the Workers RPC host bridge;
- the exported Dynamic Worker entrypoint/class;
- initialization of `makeSandboxKernel(...)` imported from
  `@ptools/executor/sandbox`.

At build time, host-cloudflare should bundle that complete entrypoint:

```txt
packages/host-cloudflare/src/executor/sandbox-worker.ts
  + @ptools/executor/sandbox
  + Cloudflare RPC adapter code
  -> esbuild with write: false
  -> complete JavaScript module text
  -> generated DYNAMIC_SANDBOX_WORKER_SOURCE constant
```

Illustrative build logic:

```ts
const result = await build({
  entryPoints: ["src/executor/sandbox-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["cloudflare:workers", "./generated-code.js"],
  write: false,
});

const source = result.outputFiles[0].text;
```

Generated code changes for every execution and cannot be evaluated with
`eval`/`new Function`, so it remains a second Loader module. The fixed bundle
keeps an external `./generated-code.js` import that the Loader resolves against
the per-execution module:

```ts
const worker = env.LOADER.load({
  compatibilityDate,
  mainModule: "code-mode-sandbox.js",
  modules: {
    "code-mode-sandbox.js": DYNAMIC_SANDBOX_WORKER_SOURCE,
    "generated-code.js": renderGeneratedCodeModule(request.code),
  },
  globalOutbound: null,
});
```

“Complete host bundle” therefore means the complete **fixed** Cloudflare
adapter and kernel. It does not mean that request-specific generated code is
known at package build time.

The exact entrypoint and RPC shape belong to the Cloudflare runtime ticket.
This document fixes only artifact ownership and build direction.

## Removal Of `@ptools/executor/sandbox-source`

The executor package previously built and exported
`SANDBOX_KERNEL_MODULE_SOURCE` through `@ptools/executor/sandbox-source`. It was
a string containing only the dependency-free shared kernel bundle.

That export could support a multi-module Dynamic Worker composition:

```ts
modules: {
  "kernel.js": SANDBOX_KERNEL_MODULE_SOURCE,
  "sandbox-worker.js": cloudflareAdapterSource,
}
```

This is technically valid, but it gives executor ownership of a distribution
format introduced for source-loader platforms while still leaving each host to
build its adapter separately. It also creates two public representations of
the same kernel:

- executable module code at `@ptools/executor/sandbox`;
- serialized module source at `@ptools/executor/sandbox-source`.

That export has been removed because it had no runtime consumer and made
executor own a source-loader distribution format. The accepted direction is:

1. Treat `@ptools/executor/sandbox` as the canonical reusable kernel export.
2. Let each host bundle that module with its own adapter.
3. Let host-cloudflare convert its complete fixed bundle into source text when
   its Worker Loader integration is implemented.
4. Keep request-specific generated code as a separate Loader module.

The removed surface included executor's `build:sandbox` script, esbuild
development dependency, `./sandbox-source` export, README guidance, and the
test that inspected the generated source constant. Kernel dependency freedom
is now checked against source boundaries and the final host-node worker bundle.

## Why The Full Host Bundle Is Preferred

Bundling the platform entrypoint and kernel together provides:

- one fixed host-owned sandbox artifact per platform;
- no runtime dependency resolution inside the untrusted sandbox;
- exact version coupling between a bridge and the kernel it initializes;
- platform-specific compilation kept outside executor;
- simpler Loader input for Cloudflare;
- clearer package ownership;
- one place per host to configure target, source maps, and platform globals.

It also preserves the important abstraction:

```txt
shared kernel contract
  + selected platform adapter
  = selected platform sandbox artifact
```

The platform adapter is replaceable without changing the kernel. The final
artifact is platform-specific by design.

## Alternatives Considered

### Keep the `.ts`/`.js` runtime switch

It works but couples production runtime code to repository source layout. It is
acceptable as an interim implementation, not the preferred final contract.

### Probe several candidate worker paths

Rejected. Filesystem probing creates a quiet fallback matrix and can hide
broken package contents until a particular environment is used.

### Ask users to configure the packaged worker path

Rejected for the default runtime. The package builds and owns the worker, so it
must locate it deterministically. User configuration is appropriate for the
Deno executable, not for an internal package artifact.

### Publish the Deno worker from executor

Rejected. The stdio bridge and Deno program loader are platform-specific and
belong to host-node. Executor should not publish a Deno entrypoint merely
because that entrypoint imports the shared kernel.

### Embed the Deno worker source and execute it with `deno eval`

Rejected as the default. It changes invocation, module identity, source-map
behavior, and debugging without improving the trust boundary. A companion
module file is a normal Node/ESM runtime asset.

### Use `import.meta.resolve()` without a package mapping

Resolving `./sandbox-worker.js` is equivalent in principle to a sibling
`new URL(...)` and does not solve source-versus-dist layout. The private
`#sandbox-worker` mapping is the part that makes the artifact location explicit
and identical from source and built modules.

### Make executor publish a kernel source string for every source-loader host

Rejected as the default ownership rule. Hosts may need different wrappers,
module layouts, compatibility targets, or RPC bindings. The host should build
the complete artifact it asks its platform to execute.

## Bundler Expectations For Consumers

`@ptools/host-node` is a Node runtime package that launches an external Deno
process and depends on a companion worker asset. An application bundler may
rewrite module URLs or omit files that are not part of its JavaScript graph.

The first supported policy should therefore be:

> Keep `@ptools/host-node` external when bundling an application, and install
> its published package with the companion worker intact.

If bundled host-node applications later become a concrete requirement, add a
documented bundler integration that copies and rewrites the worker asset. Do
not add runtime path probing or silently switch to evaluation as a generic
fallback.

## Build And Verification Requirements

Any migration implementing this decision should verify:

### Executor

- normal modular TypeScript output builds without a specialized kernel bundle;
- `@ptools/executor/sandbox` remains importable;
- no `sandbox-source` package export or generated artifact is required;
- no Effect, Node, Deno, or Cloudflare runtime dependency enters the kernel.

### Host-node

- the executor builds before the host-node worker bundle;
- the private `#sandbox-worker` mapping resolves from source-driven tests;
- the same mapping resolves from the packed installation;
- `sandbox-worker.js` exists in the npm tarball;
- Deno runs the packaged worker with the deny-all permissions currently
  required by the runtime;
- source maps remain adjacent to the worker when shipped.

### Host-cloudflare

- the fixed platform entrypoint and kernel are bundled into one module source;
- `./generated-code.js` remains an intentional external import and is supplied
  as the second per-execution Loader module;
- no Node or Effect dependency leaks into the generated sandbox artifact;
- Loader input declares the bundled module as `mainModule`;
- generated code receives only explicitly provided bindings;
- global outbound access remains disabled unless a later reviewed decision
  changes it;
- local Worker tests exercise the same generated source used for deployment.

### Repository-level packaging

Run the relevant focused tests, followed by:

```sh
pnpm typecheck
pnpm build
pnpm pack:dry-run
pnpm smoke:packed-install
```

Inspect the packed host-node tarball whenever worker layout or package mappings
change. Source-tree tests alone do not prove that the published runtime asset
is usable.

## Implementation Sequence

1. Executor now emits the shared kernel through ordinary `tsc` output and no
   longer publishes `sandbox-source`.
2. Host-node now resolves its sole esbuild-owned worker through the private
   `#sandbox-worker` package mapping.
3. Verify source tests, the Deno integration, and the packed host-node worker.
4. Later, implement the host-cloudflare Dynamic Worker adapter and generate its
   fixed adapter-plus-kernel source artifact.
5. Supply generated code as a separate Loader module for each execution.
6. Update this document if actual Loader or bundler constraints require a
   different final shape.

## Short Recall Version

```txt
Executor owns the dependency-free kernel module.
Each host owns its loader, transport bridge, and final sandbox artifact.

host-node:
  platform entrypoint + kernel -> bundled JS file -> Deno subprocess

host-cloudflare:
  fixed platform entrypoint + kernel -> bundled JS source
  per-execution generated code -> second Loader module

Do not make executor own Deno or Cloudflare entrypoints.
Do not make users locate internal worker assets.
Do not keep a kernel-only source export without a concrete consumer.
```
