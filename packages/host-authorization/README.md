# @ptools/host-authorization

Platform-neutral host permission, registered-host access, and Effect authorization contracts.

The default and `./contracts` exports provide caller, permission, registered-host, role, and membership-access contracts. `HostRole.roleKey` is a stable application identity and never a database primary key. Member/Admin/Owner are package-authored `HostRole` constants consumed by platform initialization. The `./effect` export provides `HostAuthorizationContext`, code-owned policies, and the abstract `HostAccessStore` capability.

This package does not authenticate callers, query persistence, run migrations, seed a database, or locate host runtimes. Each platform owns its persistence schema, decodes role reads into `HostRole`, and installs the package-authored built-ins during platform initialization before publishing its production `HostAccessStore` Layer.

## Host access operations

Each `HostAccessStore` method has one documented module under `src/contracts/hostAccessOperations/`. The module identifies the operation's branded input, direct domain success, typed error union, and behavioral laws. The service returns `RegisteredHost`, `HostMemberAccess`, and `HostRole` directly instead of wrapping them in single-field result DTOs.

`CreatedOwnedHost` is retained because owned-host creation genuinely publishes a host and creator access together. Its intrinsic host/access relationship is encoded with `Schema.check`, so ordinary `.make` and `.makeEffect` enforce it. Relationships between an operation input and its returned domain value are service laws exercised by every platform's contract suite, not optional `make...Result` helpers.

These are direct semantic Effect-service operations. They intentionally do not add HTTP/RPC request envelopes or operation tags: the invoked `HostAccessStore` method already identifies the operation, while later carriers own their own envelopes and success schemas.
