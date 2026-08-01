# @ptools/host-authorization

Platform-neutral host permission contracts and Effect authorization policies.

This package does not authenticate callers, query persistence, or locate host runtimes. Ingress adapters resolve one request's authority and provide `HostAuthorizationContext`; code-owned policies then decide whether protected work may run.
