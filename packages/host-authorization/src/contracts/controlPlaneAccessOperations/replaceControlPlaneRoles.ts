import { Brand, Schema } from "effect";
import type {
  ControlPlaneAccessInvariantViolation,
  ControlPlaneAccessStoreError,
  ControlPlaneRolesNotFound,
  LastControlPlaneAdministrator,
} from "../controlPlaneAccessErrors.js";
import { ControlPlaneRoleIdSelection } from "../controlPlaneRole.js";
import { PrincipalId } from "../principal.js";

/** Caller-authored replacement; trusted assignment attribution is separate. */
export class ReplaceControlPlaneRolesInput extends Schema.Class<
  ReplaceControlPlaneRolesInput,
  Brand.Brand<"ReplaceControlPlaneRolesInput">
>("ReplaceControlPlaneRolesInput")({
  principalId: PrincipalId,
  roleIds: ControlPlaneRoleIdSelection,
}) {}

/** Complete trusted store command built after Principal-caller admission. */
export class ReplacePrincipalControlPlaneRolesInput extends Schema.Class<
  ReplacePrincipalControlPlaneRolesInput,
  Brand.Brand<"ReplacePrincipalControlPlaneRolesInput">
>("ReplacePrincipalControlPlaneRolesInput")({
  principalId: PrincipalId,
  roleIds: ControlPlaneRoleIdSelection,
  assignedByPrincipalId: PrincipalId,
}) {}

export type ReplacePrincipalControlPlaneRolesError =
  | ControlPlaneRolesNotFound
  | LastControlPlaneAdministrator
  | ControlPlaneAccessInvariantViolation
  | ControlPlaneAccessStoreError;
