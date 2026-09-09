import { Brand, Schema } from "effect";
import type {
  ControlPlaneAccessInvariantViolation,
  ControlPlaneAccessStoreError,
} from "../controlPlaneAccessErrors.js";
import { PrincipalId } from "../principal.js";

/** Principal whose current global role-derived authority must be resolved. */
export class ResolvePrincipalControlPlaneAccessInput extends Schema.Class<
  ResolvePrincipalControlPlaneAccessInput,
  Brand.Brand<"ResolvePrincipalControlPlaneAccessInput">
>("ResolvePrincipalControlPlaneAccessInput")({ principalId: PrincipalId }) {}

export type ResolvePrincipalControlPlaneAccessError =
  | ControlPlaneAccessInvariantViolation
  | ControlPlaneAccessStoreError;
