/**
 * Public config package surface.
 *
 * The default export keeps schemas, parsing helpers, typed errors, and service
 * tags together for compatibility. DTO-only consumers can use `./contracts`,
 * and Effect-native service consumers can use `./effect`.
 */
export * from "./contracts/index.js";
export * from "./config.js";
export * from "./configErrors.js";
export * from "./services/index.js";
