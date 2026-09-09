import type {
  ControlPlaneAccessInvariantViolation,
  ControlPlaneAccessStoreError,
} from "../controlPlaneAccessErrors.js";
import type { Principal } from "../principal.js";

/** Idempotent verified-Principal registration result and typed failures. */
export type EnsurePrincipalError =
  | ControlPlaneAccessInvariantViolation
  | ControlPlaneAccessStoreError;
export type EnsurePrincipalSuccess = Principal;
