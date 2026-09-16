/** Strict JSON codec for the immutable permission snapshot on a Host token. */
import { HostTokenPermissionSelection } from "@ptools/host-authorization";
import { Schema } from "effect";

const PersistedHostTokenPermissions = Schema.fromJsonString(
  HostTokenPermissionSelection,
);

/** Decodes one complete persisted grant snapshot without sorting or dropping values. */
export const decodeHostTokenPermissions = Schema.decodeUnknownEffect(
  PersistedHostTokenPermissions,
);

/** Encodes an already validated grant snapshot for the private SQLite column. */
export const encodeHostTokenPermissions = Schema.encodeSync(
  PersistedHostTokenPermissions,
);
