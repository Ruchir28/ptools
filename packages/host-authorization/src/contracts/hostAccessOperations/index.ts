/**
 * Complete semantic operation contracts for `HostAccessStore`.
 *
 * Every child module documents one store method's schema-backed input, direct
 * domain success, typed failure union, and behavioral laws. These are direct
 * Effect-service contracts, not HTTP or RPC request/response envelopes.
 *
 * Naming convention:
 * - `get...` returns exactly one value or a typed `...NotFound` failure;
 * - `list...` returns a collection;
 * - `resolve...` derives effective information;
 * - `create...` and `replace...` perform semantic mutations.
 *
 * Platform implementations decode private persistence into shared domain
 * schemas. Intrinsic invariants are enforced by those schemas; input/output
 * correlation, deterministic ordering, and mutation atomicity are service laws
 * exercised by every platform's shared contract suite.
 */
export * from "./createMembership.js";
export * from "./createOwnedHost.js";
export * from "./getHostRole.js";
export * from "./getRegisteredHost.js";
export * from "./listHostRoles.js";
export * from "./listPrincipalHosts.js";
export * from "./listRegisteredHosts.js";
export * from "./replaceMembershipRoles.js";
export * from "./resolvePrincipalHostAccess.js";
