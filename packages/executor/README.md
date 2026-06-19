# @ptools/executor

Internal runtime building block for ptools packages.

This package defines host-neutral Code Mode execution rules, sandbox protocol
DTOs, the host-side `SandboxRuntime` Effect capability, and the dependency-free
sandbox kernel. Generated code stays plain JavaScript; host-side execution and
capability dispatch remain Effect-based.

Hosts provide a `SandboxRuntime` layer describing how a sandbox is constructed
and reached. The shared `ExecutorBackendLayer` adapts prepared requests to that
runtime, so a complete executor cannot be assembled without choosing a concrete
runtime. Physical processes, Dynamic Workers, remote sessions, and their
transports remain private to host packages such as `@ptools/host-node`.

Inside a sandbox, `makeSandboxKernel(hostBridge)` captures the required
platform bridge before any program can execute. The kernel is available from
`@ptools/executor/sandbox` as ordinary modular JavaScript. Each host bundles
that kernel with its own program loader and transport bridge into the final
artifact its sandbox platform executes.

For the alpha user guide, install and use `@ptools/agent-tools`.
