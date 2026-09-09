/**
 * Contract for `HostAccessStore.createOwnedHost`.
 *
 * Input: a requested host ID plus the authenticated creator identity supplied
 * by trusted middleware. Success: one aggregate proving that the registered Host
 * and creator Owner access became visible together.
 *
 * The implementation resolves the package-owned
 * `BuiltInHostRoles.owner.roleId`, proves that exact UUID still identifies an
 * installed role, and creates the Host, membership, and assignment in one
 * atomic operation. It must not scan roles or identify Owner by display name or
 * permissions, and it must not accept the default role ID from a caller.
 *
 * Because the built-in UUID is already stable application identity, platforms
 * need neither a seed binding nor a stored generated-ID reference. They remain
 * free to map the UUID to a private database primary key internally.
 *
 * Law: `host.hostId` equals `input.requestedHostId`,
 * `ownerAccess.principalId` equals `input.ownerPrincipalId`, and the returned
 * permissions are resolved from the assigned default Owner role. The aggregate
 * schema itself enforces that `host` and `ownerAccess` share one Host ID.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  RegisteredHostAlreadyExists,
} from "../hostAccessErrors.js";
import { HostMemberAccess } from "../hostMemberAccess.js";
import { PrincipalId } from "../principal.js";
import { RegisteredHost } from "../registeredHost.js";

/** Trusted creation input; `ownerPrincipalId` is never accepted directly from HTTP. */
export class CreateOwnedHostInput extends Schema.Class<
  CreateOwnedHostInput,
  Brand.Brand<"CreateOwnedHostInput">
>("CreateOwnedHostInput")({
  requestedHostId: Schema.NonEmptyString,
  ownerPrincipalId: PrincipalId,
}) {}

const matchingHostAndOwnerAccess = Schema.makeFilter(
  ({
    host,
    ownerAccess,
  }: {
    readonly host: RegisteredHost;
    readonly ownerAccess: HostMemberAccess;
  }) => host.hostId === ownerAccess.hostId,
  { expected: "host and owner access belonging to the same registered host" },
);

/**
 * Atomic owned-host creation outcome.
 *
 * Unlike the other store successes, this is a real aggregate rather than a
 * single-field operation wrapper. Its intrinsic host/access relationship is
 * enforced by the schema, so ordinary `.make` and `.makeEffect` are safe.
 */
export class CreatedOwnedHost extends Schema.Class<
  CreatedOwnedHost,
  Brand.Brand<"CreatedOwnedHost">
>("CreatedOwnedHost")(
  Schema.Struct({
    host: RegisteredHost,
    ownerAccess: HostMemberAccess,
  }).pipe(Schema.check(matchingHostAndOwnerAccess)),
) {}

/** Failures published by `HostAccessStore.createOwnedHost`. */
export type CreateOwnedHostError =
  | RegisteredHostAlreadyExists
  | HostAccessInvariantViolation
  | HostAccessStoreError;
