import { Schema } from "effect";
import { HostTokenId } from "./hostTokenIdentity.js";

/** Human caller authenticated through a Better Auth session. */
export const UserSessionCaller = Schema.TaggedStruct("UserSessionCaller", {
  userId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
export type UserSessionCaller = Schema.Schema.Type<typeof UserSessionCaller>;

/** Unattended caller authenticated through one persisted host-bound token. */
export const HostTokenCaller = Schema.TaggedStruct("HostTokenCaller", {
  tokenId: HostTokenId,
  hostId: Schema.NonEmptyString,
});
export type HostTokenCaller = Schema.Schema.Type<typeof HostTokenCaller>;

/**
 * Neutral authenticated identity safe to include in trusted host dispatch.
 * Raw credentials and authentication implementation objects never enter it.
 */
export const HostCallerPrincipal = Schema.Union([
  UserSessionCaller,
  HostTokenCaller,
]);
export type HostCallerPrincipal = Schema.Schema.Type<
  typeof HostCallerPrincipal
>;
