# @ptools/host-cloudflare

Cloudflare host adapters for ptools.

This package owns the Cloudflare Worker ingress surface and Durable Object
handoff for hosted Code Mode. The first implementation slice exposes only the
Effect v3 Worker ingress, public bearer auth, route parsing, and typed Durable
Object RPC boundary.

The runtime uses standard Cloudflare bindings and keeps Alchemy out of Worker
modules. A later deploy slice will provision those bindings with Alchemy v1.

```ts
import worker from "@ptools/host-cloudflare/worker";

export default worker;
```

A later deploy stack will point an Alchemy v1 `Worker` resource at this
entrypoint and bind the public token plus Durable Object namespace.

First-release Cloudflare stdio MCP over Containers is intentionally out of
scope. HTTP upstream MCP support is implemented in later runtime slices.
