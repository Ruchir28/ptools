import * as Effect from "effect/Effect";
import { unauthorized, type HostCloudflareError } from "../errors.js";

export const verifyBearerToken = (input: {
  readonly token: string;
  readonly accessToken: string;
}): Effect.Effect<void, HostCloudflareError> =>
  Effect.gen(function* () {
    if (input.accessToken.length === 0) {
      return yield* unauthorized();
    }

    const matches = yield* timingSafeTokenEquals(
      input.token,
      input.accessToken,
    );

    if (!matches) {
      return yield* unauthorized();
    }
  });

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
