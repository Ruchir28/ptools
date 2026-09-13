/** Shared safe HTTP projection for Host authorization admission failures. */
import {
  HostHttpForbidden,
  HostHttpInternalError,
  type HostHttpError,
} from "../contracts/hostHttpErrors.js";

/**
 * Preserve operation-adapter HTTP failures while safely projecting shared
 * authorization failures for both machine and browser JSON handlers.
 *
 * Persistence/invariant details are intentionally collapsed to a generic 500;
 * denial, route mismatch, Principal-kind mismatch, and absent registration use
 * one 403 projection so public callers cannot distinguish inaccessible Hosts.
 */
export const toHostAuthorizationHttpError = (error: {
  readonly _tag?: string;
}): HostHttpError | HostHttpForbidden => {
  switch (error._tag) {
    case "HostHttpBadRequest":
    case "HostHttpUnauthorized":
    case "HostHttpHostUnavailable":
    case "HostHttpInternalError":
      return error as HostHttpError;
    case "HostAuthorizationDenied":
    case "HostTokenRouteMismatch":
    case "PrincipalCallerRequired":
    case "RegisteredHostNotFound":
      return new HostHttpForbidden({ message: "operation was not permitted" });
    default:
      return new HostHttpInternalError({
        message: "Host authorization failed",
      });
  }
};
