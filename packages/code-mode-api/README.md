# @ptools/code-mode-api

Host-neutral Code Mode client/server API contracts.

This package contains the shared request/response types, Effect services, typed
API boundary errors, and validation helpers used between adapters and host
packages.

It does not create Code Mode, load configuration files, register MCP tools,
open transports, or depend on a specific host.
