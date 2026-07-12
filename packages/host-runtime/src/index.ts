/**
 * Shared host-runtime surface for platform-owned `ManagedRuntime`s.
 *
 * Normal platform path: install `HostStableRuntimeLayer`, then enter configured
 * work through `ConfiguredHostContextRunner`. Remaining exports support tests
 * and custom composition without platform-specific wrappers.
 */
export * from "./errors.js";
export * from "./layers/index.js";
export * from "./services/index.js";
