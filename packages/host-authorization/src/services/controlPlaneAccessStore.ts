import { Context, Effect } from "effect";
import type {
  ClaimInitialAdministratorRecordInput,
  ControlPlaneClaimStatus,
  InitializeControlPlaneInput,
} from "../contracts/controlPlaneBootstrap.js";
import type {
  ClaimInitialAdministratorError,
  GetControlPlaneClaimStatusError,
  InitializeControlPlaneError,
  ReplacePrincipalControlPlaneRolesError,
  ReplacePrincipalControlPlaneRolesInput,
  ResolvePrincipalControlPlaneAccessError,
  ResolvePrincipalControlPlaneAccessInput,
  EnsurePrincipalError,
} from "../contracts/controlPlaneAccessOperations/index.js";
import type { PrincipalControlPlaneAccess } from "../contracts/controlPlaneRole.js";
import type { Principal } from "../contracts/principal.js";

/**
 * Platform persistence port for global Principal authority and initial claim.
 *
 * This shared semantic port defines the mutation laws of Control Plane
 * authority; platform implementations own only the mechanism that makes those
 * laws atomic. Guarantees such as "the first valid claim wins and grants
 * Administrator" and "at least one Administrator must remain" span a read, a
 * decision, and a write, so the implementation must enforce them within the
 * mutation itself. A generic store of read/write primitives plus shared
 * read-then-decide orchestration cannot preserve that guarantee: on Cloudflare
 * D1, for example, any JavaScript decision between separate reads and writes
 * reopens the two-concurrent-claims race.
 *
 * Each platform therefore implements every multi-step mutation as one native
 * atomic unit—a conditional SQL transaction or batch, or the in-memory
 * `SynchronizedRef` transition—while shared orchestration remains
 * storage-free. `ControlPlaneBootstrap` generates and hashes setup plaintext
 * and timestamps a claim; `ControlPlaneAdministration` combines caller-authored
 * input with trusted Principal attribution. This store validates persisted
 * facts, including the presented setup digest, and commits the corresponding
 * authority mutation atomically. The mechanism varies by platform; operation
 * meaning does not.
 */
export class ControlPlaneAccessStore extends Context.Service<
  ControlPlaneAccessStore,
  {
    /**
     * Creates unclaimed Control Plane state whose only persisted setup-secret
     * material is the capability digest. It assigns no roles and registers no
     * Principals; the Administrator grant happens at initial claim. Returns
     * `true` only when this call created the state, allowing
     * `ControlPlaneBootstrap` to return setup plaintext exactly once to the
     * provisioning path.
     */
    readonly initialize: (
      input: InitializeControlPlaneInput,
    ) => Effect.Effect<boolean, InitializeControlPlaneError>;

    /**
     * Idempotently registers one verified durable Principal for role and audit
     * references. Registration creates no assignment and grants no authority;
     * callers must use the dedicated claim or role-replacement mutations.
     */
    readonly ensurePrincipal: (
      principal: Principal,
    ) => Effect.Effect<Principal, EnsurePrincipalError>;

    /**
     * Returns the current public claim state without exposing the persisted
     * setup digest. Missing or contradictory platform state is an invariant
     * failure rather than being projected as an unclaimed installation.
     */
    readonly getClaimStatus: () => Effect.Effect<
      ControlPlaneClaimStatus,
      GetControlPlaneClaimStatusError
    >;

    /**
     * Consumes setup authority exactly once, as one atomic unit: the store
     * compares the presented digest against the unclaimed state, registers the
     * claimant, installs and grants the built-in Control Plane Administrator
     * role, and transitions to Claimed. Any second claim, and any digest
     * mismatch, fails with `ControlPlaneClaimRejected` without mutating state.
     */
    readonly claimInitialAdministrator: (
      input: ClaimInitialAdministratorRecordInput,
    ) => Effect.Effect<
      PrincipalControlPlaneAccess,
      ClaimInitialAdministratorError
    >;

    /**
     * Resolves one Principal's current global authority from persisted Control
     * Plane role assignments. The result is a permission projection for
     * authorization, not an assignment record, and this read performs no
     * mutation or role installation.
     */
    readonly resolvePermissions: (
      input: ResolvePrincipalControlPlaneAccessInput,
    ) => Effect.Effect<
      PrincipalControlPlaneAccess,
      ResolvePrincipalControlPlaneAccessError
    >;

    /**
     * Atomically replaces one Principal's complete Control Plane role
     * selection and returns the resulting effective permissions. The store
     * rejects unknown role UUIDs and any replacement that would leave no
     * Administrator; an empty selection remains valid for an ordinary
     * Principal when another Administrator remains.
     */
    readonly replaceRoles: (
      input: ReplacePrincipalControlPlaneRolesInput,
    ) => Effect.Effect<
      PrincipalControlPlaneAccess,
      ReplacePrincipalControlPlaneRolesError
    >;
  }
>()("@ptools/host-authorization/ControlPlaneAccessStore") {}
