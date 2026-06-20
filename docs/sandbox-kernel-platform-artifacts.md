# Sandbox Kernel And Platform Artifact Ownership

Status: accepted architecture direction. Executor and host-node migration
implemented; host-cloudflare implementation remains future work.

Last reviewed: 2026-06-20.

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

## How An Execution Runs: Loader Versus Kernel

The boundaries table names the owners. It does not show the handoff between
them, which is where most confusion arises. A sandbox execution has two distinct
phases that happen in different packages, at different times, with a strict security boundary:

1. **Phase 1: Compile-Time (Owned by the Platform Entrypoint / Loader)**
   - **What it does:** The platform loader takes the raw generated code string and turns it into an executable, callable JavaScript function (`SandboxProgram`).
   - **Scope configuration:** This is the only stage where "function compilation" occurs. The loader defines the parameter signature of this function, destructuring variables from a single input object (referred to internally as `__bindings` or argument list).
   - **Key Constraint:** The loader owns the **compilation** and the **syntactic structure** of the namespace. It derives the lexical variable names from the shared binding plan and reports the exact keys it compiled with. However, it does not build or supply any of the actual values behind those names.
2. **Phase 2: Run-Time (Owned by the Shared Kernel)**
   - **What it does:** The kernel accepts the pre-compiled `SandboxProgram` and hydrates it with real runtime capabilities. It assembles the execution context, injects safe globals, creates custom tool/provider proxies, executes the program, monitors pending async promises, intercepts console logs, and outputs the final execution envelope (`SandboxCompletion`).
   - **Key Constraint:** The kernel never compiles code. It solely **consumes** the compiled function produced in Phase 1, injects its own runtime values/proxies into it, tracks its execution state, and standardizes errors and results.

### The Security & Design Boundary: "Names Only, No Implementations"

Neither phase reaches into the other's domain. The wire payload crossing the host-to-sandbox transport is defined as:

`SandboxExecutionPayload = { code, globals, providers }`

Where `providers` is an array of `SandboxProviderManifest = { name, tools }`.

This is a critical design constraint: **the sandbox is completely untrusted and has no direct network/file access. Therefore, no actual tool implementation code is sent to or loaded within the sandbox.**

Instead, the payload contains **only the names of the providers and tools** (the "manifest").

- **At Phase 1 (Compile-time):** The platform loader reads these names through the shared binding plan solely to compile the parameter list (e.g., creating a parameter named `sheets`) and records the `bindingKeys` it used.
- **At Phase 2 (Run-time):** The kernel verifies those `bindingKeys` against the same plan, then reads these names to construct a local JavaScript `Proxy` (a mock object) matching that exact namespace structure. When the untrusted code calls `await sheets.read(...)` in the sandbox, the proxy intercepts the call and forwards a request over the `SandboxHostBridge` back to the trusted host. The host executes the actual tool code securely and replies with the result.

```txt
TRUSTED HOST                          UNTRUSTED SANDBOX (per-platform entrypoint)
(effect runtime, provider dispatch)   (e.g. host-node sandbox-worker.ts in Deno)
─────────────────────────────         ───────────────────────────────────────────

prepare an execution:
  globals   = { apiKey: "...", ... }
  providers = [{ name: "sheets", tools: ["read"] }, ...]
  code      = "async () => { sheets.read(...); ... }"
        │
        │  Execute { code, globals, providers }   (over transport: stdio / RPC)
        ▼
                                      ── PHASE 1: COMPILE  (platform loader) ──

                                      plan = sandboxBindingPlan(globals, providers)
                                      bindingKeys = plan.map(b => b.key)
                                      program = new Function("__bindings",
                                                `const { ${bindingKeys} } = __bindings;
                                                 return (${code})();`)

                                        ▸ output: a callable SandboxProgram + bindingKeys
                                        ▸ owns: compilation only
                                        ▸ does NOT build any runtime values

                                      ── PHASE 2: RUN  (shared kernel) ──

                                      kernel.execute({ program, bindingKeys, globals, providers })

                                      plan = sandboxBindingPlan(globals, providers)
                                      assert bindingKeys === plan.map(b => b.key)
                                      materialize bindings from the plan:
                                        global   → execution.globals[key]
                                        provider → kernel-built provider proxy
                                        kernel   → kernel-built fixed capability

                                      await program(bindings)
                                      tracks pending calls via bridge.invokeProvider
                                      drains, serializes errors
                                        ▸ SandboxCompletion
        │
        │  Complete { ok, value, logs, warnings }   (over transport)
        ▼
resumes Effect runtime, exposes result
```

### Who Supplies Each Binding The Program Receives

The bindings object the kernel hands to `program(...)` is assembled from three
distinct categories with **different ownership**. This is the key nuance behind the
question "does the kernel own the values?" — it does not own them wholesale:

| Binding key   | Value supplied by                                                                                              | Name (key) supplied by                             | What the kernel actually does                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `globals.*`   | **Host** (over the wire, in the payload)                                                                       | Host (`Object.keys` of the payload's `globals`)    | Pure passthrough: spreads `...execution.globals` unchanged — neither the values nor their keys are kernel-owned                          |
| `providers.*` | **Kernel** builds callable proxies; host supplies only a manifest of `{ name, tools }` with no implementations | Host (the manifest names)                          | Builds an async proxy per tool that routes through `bridge.invokeProvider`, mints `callId`s, validates correlation, tracks pending calls |
| `console`     | **Kernel** (`makeCapturedConsole`) built from scratch                                                          | Kernel (the host has no knowledge of this binding) | Constructs a captured-console proxy so sandbox logs do not corrupt the transport stream                                                  |

To summarize the ownership model:

- **The Platform Loader (Phase 1)** owns _none of the values_. It only decides the syntactic names that the generated code is allowed to reference and compiles the wrapper function.
- **The Host** owns the actual raw input values of `globals` and the list of available `providers`. It never owns the callable execution behaviors or sandbox logging.
- **The Shared Kernel (Phase 2)** owns the **assembly** of the final execution scope. It owns `console` outright (to capture logs safely), builds the dynamic provider proxies over the host-provided manifests, and forwards everything to the compiled program. This ensures that the untrusted sandbox contains only lightweight communication shells, keeping the real, secure tool logic on the host side.

---

### Architectural Deep Dive: Why Does the Kernel Materialize Instead of the Platform Loader?

A common architectural question when looking at this division is: **"Why are we doing the extra work of generating a binding plan and verifying it, rather than simply having each platform loader materialize the bindings directly and pass them to the kernel?"**

The answer is a deliberate trade-off designed to prioritize **extensibility**, **robust sandboxing**, and **DRY (Don't Repeat Yourself) code** as we scale to multiple platforms (Deno, Cloudflare Workers, Node, Browser isolates, etc.).

#### 1. Preventing "Fat" Platform Loaders (Eliminating Code Duplication)
Materializing a binding is not a simple value assignment. It requires substantial execution logic:
- **Dynamic Proxies**: Generating nested JavaScript `Proxy` shells so that the sandboxed code can use natural function call syntax (e.g. `await sheets.read(...)`).
- **RPC Call-Id Generation & Correlation**: Generating unique `callId`s for each tool execution, tracking correlation, and mapping results.
- **Async Lifecycles & Isolate Eviction Prevention**: If the untrusted sandboxed code executes a tool call without `await`ing it (running in the background), the platform might prematurely terminate the isolate when the main thread resolves. The kernel must track every single floating background promise in a `pendingProviderCalls` Set, awaiting and draining them (`Promise.all`) before finalizing.
- **Console Capture**: Intercepting `console.log` statements securely into memory without leaking or corrupting standard stdout.

If the platform loaders materialized the bindings, **every single platform package (Deno, Cloudflare, etc.) would have to write, maintain, and test their own version of this complex proxy and lifecycle management logic.**
By having the **Shared Kernel** handle materialization, platform loaders remain extremely "lean, stupid, and safe." They only have to compile the code string and handle raw byte transport (I/O).

#### 2. Strict Sandboxing and Avoiding Leakage
The platform loader operates directly on the boundary of the sandbox, meaning its execution scope has access to platform internals (e.g. standard I/O streams, the Deno subprocess global, or raw environment variables). 
If the loader materialized the bindings object, it might accidentally close over or leak platform-specific variables into the untrusted user code's scope. 
By delegating materialization to the Shared Kernel running entirely inside the sandboxed environment, we ensure that the objects passed to the compiled program are constructed in a completely sterile, isolated space with zero risk of leakages.

#### 3. Guaranteed Lifecycle Consistency Across Platforms
Because the Shared Kernel manages the entire lifecycle of the function execution—specifically catching errors, capturing console output, and draining background async tasks—it guarantees identical execution behaviors whether running in a local Deno subprocess on a developer's laptop, or inside a Cloudflare Workers isolate in production. We do not have to rely on individual platform loaders implementing these tricky asynchronous semantics correctly.

---

### The Name-Coordination Seam

Phase 1 destructures a list of names at compile time. Phase 2 assembles an
object whose keys must be exactly that list. The shared contract is therefore a
plan, not a hand-written object spread.

`packages/executor/src/sandbox/kernel/bindings.ts` owns
`sandboxBindingPlan(globals, providers)`. The plan is execution-specific:

```ts
[
  ...Object.keys(globals).map((key) => ({ key, source: "global" })),
  ...providers.map((provider) => ({ key: provider.name, source: "provider" })),
  { key: "console", source: "kernel" },
];
```

The platform loader consumes the plan through
`injectableBindingKeys(globals, providers)` and returns the exact `bindingKeys`
it compiled into the wrapper. The shared kernel recomputes the same plan from
`SandboxKernelExecution.globals` and `SandboxKernelExecution.providers`, fails
fast if the loader-reported `bindingKeys` differ, and then materializes the
runtime bindings from the plan:

- `source: "global"` reads `execution.globals[key]`;
- `source: "provider"` reads the kernel-created provider proxy for `key`;
- `source: "kernel"` reads a fixed kernel capability such as captured
  `console`.

This keeps function creation platform-owned while removing the previous drift
risk where the loader used one name list and the kernel manually assembled
`{ ...globals, ...providers, console }` from another implicit list.

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
): LoadedSandboxProgram {
  const bindingKeys = injectableBindingKeys(payload.globals, payload.providers);
  const program = new Function(
    "__bindings",
    `const { ${bindingKeys.join(", ")} } = __bindings; return (${payload.code})();`,
  ) as SandboxProgram;

  return { program, bindingKeys };
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
