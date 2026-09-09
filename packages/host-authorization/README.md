# @ptools/host-authorization

Platform-neutral Principal, Control Plane, Host-role, Host-token, and Effect authorization contracts.

The package keeps three concepts separate:

```txt
Principal                 durable subject that may receive roles
Host token                one Host-bound credential with frozen grants
HostAuthorizationContext  request-local effective authority used by policies
```

## Role identity

A role has one immutable application identity: a branded canonical UUID string.
It is independent of the platform's physical row identity:

```txt
shared roleId                    platform choices
<canonical UUID string>          TEXT, native UUID, or 16-byte BLOB
                                 optional private surrogate row PK
```

Built-in roles use UUIDv5 values derived by this package from one permanent
namespace and catalog-qualified canonical names such as `host/owner` and
`control-plane/administrator`. Future custom roles use generated UUIDv4 values. The
package exports complete built-in role values, and platforms insert their exact
logical IDs instead of independently reproducing the UUIDv5 derivation.

`name` is only a renameable display label. Memberships, last-Administrator
checks, default-Owner assignment, and role-catalog migrations use `roleId`;
authorization policies continue to inspect permissions rather than IDs or
names. Built-ins are recognized by equality with catalog IDs, not merely by
having UUIDv5 syntax.

Because the role UUID itself is stable migration identity, platforms need no
seed keys, seed-binding tables, or generated database-ID references. They still
persist one applied version for each of the Control Plane and Host role catalogs:
the UUID identifies which role a transition targets, while the version records
which complete transitions committed. Versions advance atomically with catalog
changes and a persisted version newer than the package fails fast.

The default and `./contracts` exports contain wire-safe schemas and domain
values. The `./effect` export contains authorization policies and services:

- `HostAccessStore` for registered Hosts and Principal Host roles;
- `ControlPlaneAccessStore` for global roles and initial claim state;
- `ControlPlaneBootstrap` for hash-only one-time setup capability handling;
- `Authorization` for current Principal authority resolution;
- `HostTokenService` / `HostTokenRecordStore` for Host-bound credentials;
- `InMemoryControlPlaneAccessStoreLayer`, a test/reference Layer for shared laws
  and Effect composition tests—not a production persistence adapter.

The in-memory Layer creates fresh process-local state each time it is built and
loses that state with the runtime or process. It cannot coordinate separate
processes, Workers, or Durable Object instances. Production Node and Cloudflare
composition must provide the platform-owned SQLite and D1 Layers instead.

Platform adapters own physical schemas, UUID encoding, migrations,
transactions, provider authentication, and initial-role insertion. SQLite and
D1 may store canonical UUID text for simplicity or convert it to an exact
16-byte BLOB; a future database may use a native UUID column. Shared code owns
the logical IDs, permission meaning, bootstrap behavior, last-Administrator
safety, token lifecycle, and authorization laws.

## Host access operations

Each `HostAccessStore` method has a focused contract under
`src/contracts/hostAccessOperations/`. Methods return `RegisteredHost`,
`HostMemberAccess`, and `HostRole` directly. `CreatedOwnedHost` remains an
aggregate because Host creation atomically resolves
`BuiltInHostRoles.owner.roleId` and publishes the Host, creator membership, and
role assignment. This lookup is internal to the adapter—not another public
`HostAccessStore` method—and must never scan or match a role name.
