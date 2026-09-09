import { Schema } from "effect";
import { HostTokenId } from "./hostTokenIdentity.js";
import { PrincipalId } from "./principal.js";

/**
 * Durable Principal identity retained after an authentication adapter verifies
 * any approved credential, such as a session cookie, JWT, or future machine
 * credential. The credential kind and provider objects remain at the
 * authentication boundary unless a specific operation requires assurance data.
 */
export const PrincipalCaller = Schema.TaggedStruct(
  "PrincipalCaller",
  { principalId: PrincipalId },
);
export type PrincipalCaller = Schema.Schema.Type<
  typeof PrincipalCaller
>;

/** Unattended caller authenticated through one persisted Host-bound token. */
export const HostTokenCaller = Schema.TaggedStruct("HostTokenCaller", {
  tokenId: HostTokenId,
  hostId: Schema.NonEmptyString,
});
export type HostTokenCaller = Schema.Schema.Type<typeof HostTokenCaller>;

/**
 * Identity facts retained after one supported credential is verified. Admission
 * resolves this caller's authority separately, so the union carries neither
 * role assignments nor effective permissions.
 */
export const HostCaller = Schema.Union([PrincipalCaller, HostTokenCaller]);
export type HostCaller = Schema.Schema.Type<typeof HostCaller>;
