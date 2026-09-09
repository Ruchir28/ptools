import type {
  ControlPlaneAccessInvariantViolation,
  ControlPlaneAccessStoreError,
  ControlPlaneClaimRejected,
} from "../controlPlaneAccessErrors.js";

export type InitializeControlPlaneError =
  | ControlPlaneAccessInvariantViolation
  | ControlPlaneAccessStoreError;
export type GetControlPlaneClaimStatusError =
  | ControlPlaneAccessInvariantViolation
  | ControlPlaneAccessStoreError;
export type ClaimInitialAdministratorError =
  | ControlPlaneClaimRejected
  | ControlPlaneAccessInvariantViolation
  | ControlPlaneAccessStoreError;
