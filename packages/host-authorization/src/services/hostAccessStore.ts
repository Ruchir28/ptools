/**
 * Runtime semantic port for central registered-host and human-access persistence.
 *
 * Each method is documented by one module under
 * `contracts/hostAccessOperations/`. Inputs are schema-backed operation values;
 * successes are the domain values callers actually need rather than transport-
 * style single-field result wrappers.
 *
 * Platform implementations decode persistence values into `RegisteredHost`,
 * `HostMemberAccess`, and `HostRole`. Input/output identity agreement, canonical
 * list ordering, and mutation atomicity are service laws exercised by the shared
 * platform contract suite. Intrinsic value invariants remain in the schemas.
 *
 * Platform migrations and built-in role installation happen before this
 * service is published and are intentionally absent from this interface.
 */
import { Context, Effect } from "effect";
import {
  type CreateHostMembershipError,
  type CreateHostMembershipInput,
  type CreateOwnedHostError,
  type CreateOwnedHostInput,
  type CreatedOwnedHost,
  type ListHostRolesError,
  type ListHostRolesInput,
  type ListUserHostsError,
  type ListUserHostsInput,
  type ReplaceMembershipRolesError,
  type ReplaceMembershipRolesInput,
  type GetHostRoleError,
  type GetHostRoleInput,
  type GetRegisteredHostError,
  type GetRegisteredHostInput,
  type ResolveUserHostAccessError,
  type ResolveUserHostAccessInput,
} from "../contracts/hostAccessOperations/index.js";
import type { HostMemberAccess } from "../contracts/hostMemberAccess.js";
import type { HostRole } from "../contracts/hostRole.js";
import type { RegisteredHost } from "../contracts/registeredHost.js";

/** Platform-owned central registered-host, role, and human-access capability. */
export class HostAccessStore extends Context.Service<
  HostAccessStore,
  {
    readonly getRegisteredHost: (
      input: GetRegisteredHostInput,
    ) => Effect.Effect<RegisteredHost, GetRegisteredHostError>;

    readonly createOwnedHost: (
      input: CreateOwnedHostInput,
    ) => Effect.Effect<CreatedOwnedHost, CreateOwnedHostError>;

    readonly listUserHosts: (
      input: ListUserHostsInput,
    ) => Effect.Effect<ReadonlyArray<RegisteredHost>, ListUserHostsError>;

    readonly resolveUserHostAccess: (
      input: ResolveUserHostAccessInput,
    ) => Effect.Effect<HostMemberAccess, ResolveUserHostAccessError>;

    readonly createMembership: (
      input: CreateHostMembershipInput,
    ) => Effect.Effect<HostMemberAccess, CreateHostMembershipError>;

    readonly replaceMembershipRoles: (
      input: ReplaceMembershipRolesInput,
    ) => Effect.Effect<HostMemberAccess, ReplaceMembershipRolesError>;

    readonly getHostRole: (
      input: GetHostRoleInput,
    ) => Effect.Effect<HostRole, GetHostRoleError>;

    readonly listHostRoles: (
      input: ListHostRolesInput,
    ) => Effect.Effect<ReadonlyArray<HostRole>, ListHostRolesError>;
  }
>()("@ptools/host-authorization/HostAccessStore") {}
