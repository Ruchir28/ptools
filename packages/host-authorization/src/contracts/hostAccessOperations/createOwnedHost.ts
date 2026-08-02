/**
 * Contract for `HostAccessStore.createOwnedHost`.
 *
 * Input: a requested host ID plus the authenticated creator identity supplied
 * by trusted middleware. Success: one aggregate proving that the registered host
 * and creator Owner access became visible together.
 *
 * Law: `host.hostId` equals `input.requestedHostId` and
 * `ownerAccess.userId` equals `input.ownerUserId`. The aggregate schema itself
 * enforces that `host` and `ownerAccess` share one host ID.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  RegisteredHostAlreadyExists,
} from "../hostAccessErrors.js";
import { HostMemberAccess } from "../hostMemberAccess.js";
import { RegisteredHost } from "../registeredHost.js";

/** Trusted creation input; `ownerUserId` is never accepted directly from HTTP. */
export class CreateOwnedHostInput extends Schema.Class<
  CreateOwnedHostInput,
  Brand.Brand<"CreateOwnedHostInput">
>("CreateOwnedHostInput")({
  requestedHostId: Schema.NonEmptyString,
  ownerUserId: Schema.NonEmptyString,
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
