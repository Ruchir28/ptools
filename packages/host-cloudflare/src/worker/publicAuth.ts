import * as Effect from "effect/Effect";
import { unauthorized, type HostCloudflareError } from "../errors.js";

export const verifyPublicWorkerAuth = (input: {
  readonly request: Request;
  readonly accessToken: string;
}): Effect.Effect<void, HostCloudflareError> =>
  Effect.gen(function* () {
    const authorization = input.request.headers.get("Authorization");
    const bearerToken = parseBearerToken(authorization);

    if (bearerToken === undefined || input.accessToken.length === 0) {
      return yield* Effect.fail(unauthorized());
    }

    const matches = yield* timingSafeTokenEquals(
      bearerToken,
      input.accessToken,
    );

    if (!matches) {
      return yield* Effect.fail(unauthorized());
    }
  });

const parseBearerToken = (authorization: string | null): string | undefined => {
  if (authorization === null) {
    return undefined;
  }

  const [scheme, token, extra] = authorization.trim().split(/\s+/u);

  if (
    scheme === undefined ||
    token === undefined ||
    extra !== undefined ||
    !/^bearer$/iu.test(scheme) ||
    token.length === 0
  ) {
    return undefined;
  }

  return token;
};

const timingSafeTokenEquals = (
  actual: string,
  expected: string,
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const encoder = new TextEncoder();
    const actualBytes = encoder.encode(actual);
    const expectedBytes = encoder.encode(expected);
    const lengthsMatch = actualBytes.byteLength === expectedBytes.byteLength;

    return lengthsMatch
      ? crypto.subtle.timingSafeEqual(actualBytes, expectedBytes)
      : !crypto.subtle.timingSafeEqual(actualBytes, actualBytes);
  });
