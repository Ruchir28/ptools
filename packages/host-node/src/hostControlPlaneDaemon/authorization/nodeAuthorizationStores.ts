/**
 * @file One composition point for Node's three authorization persistence ports.
 *
 * The merged Layer does not construct a database. Its caller supplies one
 * `NodeControlPlaneDrizzle`, ensuring all stores close over the same scoped
 * Effect SQL connection and participate in that connection's transactions.
 */
import {
  ControlPlaneAccessStore,
  HostAccessStore,
  HostTokenRecordStore,
} from "@ptools/host-authorization/effect";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  NodeControlPlaneDatabaseError,
  NodeControlPlaneDrizzle,
} from "../../services/nodeControlPlaneDrizzle.js";
import { NodeControlPlaneAccessStoreLive } from "./nodeControlPlaneAccessStore.js";
import { NodeHostAccessStoreLive } from "./nodeHostAccessStore.js";
import { NodeHostTokenRecordStoreLive } from "./nodeHostTokenRecordStore.js";
import { requireCurrentAuthorizationCatalog } from "../persistence/nodeAuthorizationCatalogPersistence.js";
import { ControlPlaneClaimRowSelectSchema } from "../persistence/nodeControlPlanePersistedSchemas.js";
import { controlPlaneClaimTable } from "../persistence/nodeControlPlaneSqliteSchema.js";

/** All durable Node authorization stores over one caller-provided database. */
export const NodeAuthorizationStoresLive: Layer.Layer<
  ControlPlaneAccessStore | HostAccessStore | HostTokenRecordStore,
  never,
  NodeControlPlaneDrizzle
> = Layer.mergeAll(
  NodeControlPlaneAccessStoreLive,
  NodeHostAccessStoreLive,
  NodeHostTokenRecordStoreLive,
);

/**
 * Startup-only catalog health assertion.
 *
 * Control-plane composition builds this Layer once at startup, alongside —
 * not underneath — the three store Layers, so a corrupted or foreign catalog
 * fails the process before any listener binds. Per-request store operations
 * strictly decode the rows they touch but do not re-run this full-catalog
 * scan.
 *
 * Branch behavior, by persisted claim state:
 *
 * - No claim row (fresh database): succeeds immediately. A fresh database
 *   has no catalog to check — the catalog is installed atomically by
 *   `claimInitialAdministrator`, which rejects any pre-existing catalog rows,
 *   so the invariant "claimed implies catalog was installed" holds by
 *   construction.
 * - Unclaimed row (digest set, no Administrator): succeeds after structural
 *   decoding, without the catalog scan. There is no granted authority yet,
 *   hence nothing the catalog could misdescribe.
 * - Claimed row (Administrator set, digest consumed): runs the full
 *   `requireCurrentAuthorizationCatalog` equality check against the
 *   package-authored built-ins and fails startup otherwise.
 *
 * Only a claim row that is both decodable *and* lifecycle-coherent reaches a
 * decision: `ControlPlaneClaimRowSelectSchema` rejects malformed column
 * values, while `oneClaimRow` (invoked by every store operation) rejects
 * contradictory lifecycles such as a row carrying both a setup digest and an
 * Administrator. Such a row can therefore never yield authority even though
 * this probe, which judges catalog health rather than claim validity, would
 * treat its non-null Administrator as the claimed branch and proceed to the
 * scan. The first store operation touching that row fails closed with
 * `ControlPlaneAccessInvariantViolation`.
 */
/** Empty startup marker: construction proves the claimed catalog is current. */
export const NodeAuthorizationCatalogStartupProbe = Context.Service<{
  readonly _tag: "NodeAuthorizationCatalogStartupProbe";
}>("@ptools/host-node/NodeAuthorizationCatalogStartupProbe");

export type NodeAuthorizationCatalogStartupProbe = Context.Service.Shape<
  typeof NodeAuthorizationCatalogStartupProbe
>;

/** Fails process startup when claimed authority carries a foreign catalog. */
export const NodeAuthorizationCatalogStartupProbeLive: Layer.Layer<
  NodeAuthorizationCatalogStartupProbe,
  NodeControlPlaneDatabaseError | SqlError | EffectDrizzleQueryError,
  NodeControlPlaneDrizzle
> = Layer.effect(
  NodeAuthorizationCatalogStartupProbe,
  Effect.gen(function* () {
    const { database } = yield* NodeControlPlaneDrizzle;
    const claimRows = yield* database
      .select()
      .from(controlPlaneClaimTable)
      .where(eq(controlPlaneClaimTable.claimId, 1));
    if (claimRows.length === 0) {
      return { _tag: "NodeAuthorizationCatalogStartupProbe" } as const;
    }
    const claim = yield* Schema.decodeUnknownEffect(
      ControlPlaneClaimRowSelectSchema,
    )(claimRows[0]).pipe(
      Effect.mapError(
        () =>
          new NodeControlPlaneDatabaseError({
            message: "stored Control Plane claim row is invalid",
          }),
      ),
    );
    if (claim.initialAdministratorId !== null) {
      yield* requireCurrentAuthorizationCatalog(database).pipe(
        Effect.mapError(
          ():
            | NodeControlPlaneDatabaseError
            | SqlError
            | EffectDrizzleQueryError =>
            new NodeControlPlaneDatabaseError({
              message: "authorization role catalog is unsupported",
            }),
        ),
      );
    }
    return { _tag: "NodeAuthorizationCatalogStartupProbe" } as const;
  }),
);
