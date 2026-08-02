import { Schema } from "effect";

/**
 * Public management identity for one persisted host token. This branded UUID is
 * shared by `HostTokenRecord`, revoke inputs, and `HostTokenCaller`, preventing
 * those boundaries from inventing interchangeable string aliases. It identifies
 * metadata only and is never accepted as a bearer credential or hash lookup key.
 */
export const HostTokenId = Schema.String.pipe(
  Schema.check(Schema.isUUID(4)),
  Schema.brand("HostTokenId"),
);
export type HostTokenId = Schema.Schema.Type<typeof HostTokenId>;
