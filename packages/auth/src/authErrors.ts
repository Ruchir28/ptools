import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Data } from "effect";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const isAuthRequiredError = (cause: unknown): boolean => {
  if (cause instanceof UnauthorizedError) {
    return true;
  }

  const message = safeErrorMessage(cause).toLowerCase();

  return (
    message.includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("missing or invalid access token") ||
    message.includes("missing required authorization header")
  );
};

export const isDynamicClientRegistrationUnsupported = (
  cause: unknown,
): boolean => {
  const message = safeErrorMessage(cause).toLowerCase();

  return (
    message.includes("dynamic client registration") &&
    (message.includes("does not support") ||
      message.includes("not supported") ||
      message.includes("incompatible auth server"))
  );
};

export const safeErrorMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};
