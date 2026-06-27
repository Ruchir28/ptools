# @ptools/code-mode-api

Host-neutral Code Mode client/server API contracts.

This package contains the shared request/response contracts, typed API boundary
errors, validation helpers, and Promise client handle used between adapters and
host packages.

- `@ptools/code-mode-api` exposes the default Promise/DTO surface.
- `@ptools/code-mode-api/contracts` exposes schema-backed shared DTO contracts.
- `@ptools/code-mode-api/effect` exposes Effect service tags.

It does not create Code Mode, load configuration files, register MCP tools,
open transports, or depend on a specific host.
