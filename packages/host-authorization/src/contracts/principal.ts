import { Brand, Encoding, Schema } from "effect";

/**
 * Opaque application identity for a durable subject that may receive roles.
 * Authentication adapters must derive external identities with `PrincipalIds`;
 * a provider subject or Host-token ID is never itself a Principal ID.
 */
export const PrincipalId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^ptools_principal_v1_(?:external_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|local_[A-Za-z0-9_-]+)$/,
    ),
  ),
  Schema.brand("@ptools/PrincipalId"),
);
export type PrincipalId = Schema.Schema.Type<typeof PrincipalId>;

/** Durable identity only; credentials and mutable authority live elsewhere. */
export class Principal extends Schema.Class<
  Principal,
  Brand.Brand<"Principal">
>("Principal")({
  principalId: PrincipalId,
}) {}

const utf8 = new TextEncoder();

/**
 * Rewrites one untrusted identity fragment into a delimiter-safe component.
 *
 * A Principal ID is a durable authorization key, not a raw identity-provider
 * string. External IDs have this framing:
 *
 * ```txt
 * ptools_principal_v1_external_<encoded issuer>.<encoded subject>
 * ```
 *
 * Concatenating raw values would make the `.` boundary ambiguous. These two
 * different identities would otherwise produce the same text:
 *
 * ```txt
 * issuer = "google",       subject = "alice.smith"
 * issuer = "google.alice", subject = "smith"
 * ```
 *
 * UTF-8 plus canonical unpadded base64url preserves every input byte while
 * restricting each component to `A-Z`, `a-z`, `0-9`, `-`, and `_`. Because `.`
 * is outside that alphabet, the only `.` in an external Principal ID is the
 * separator inserted by this package, so the issuer/subject split cannot be
 * shifted by caller input.
 *
 * Effect owns the encoding mechanism here. Using `Encoding.encodeBase64Url`
 * avoids a second hand-written codec and keeps behavior identical across Node,
 * Workers, and other hosts without relying on `Buffer` or `btoa`.
 */
const encodeComponent = (value: string): string =>
  Encoding.encodeBase64Url(utf8.encode(value));

const requireNonEmpty = (label: string, value: string): void => {
  if (value.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
};

/**
 * Trusted constructors for the durable-subject namespaces supported by V1.
 * Callers pass raw issuer/subject/local strings; these helpers encode each
 * fragment first so the stored ID cannot collide across namespaces or across
 * different splits of the same character sequence.
 */
export const PrincipalIds = {
  fromExternalSubject: (issuer: string, subject: string): PrincipalId => {
    requireNonEmpty("external identity issuer", issuer);
    requireNonEmpty("external identity subject", subject);
    return PrincipalId.make(
      `ptools_principal_v1_external_${encodeComponent(issuer)}.${encodeComponent(subject)}`,
    );
  },

  fromFixedLocalIdentity: (localId: string): PrincipalId => {
    requireNonEmpty("fixed local identity", localId);
    return PrincipalId.make(
      `ptools_principal_v1_local_${encodeComponent(localId)}`,
    );
  },
} as const;
