export * as Pagination from "./pagination.js";

import { Schema } from "effect";

/**
 * Maximum number of collection members one store call may publish.
 *
 * The limit is required on every list input so neither an internal caller nor a
 * transport adapter can accidentally request an unbounded collection. Platform
 * stores must apply it in the persistence query rather than slicing an already
 * materialized result.
 */
export const PageSize = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  Schema.brand("@ptools/PageSize"),
);
export type PageSize = Schema.Schema.Type<typeof PageSize>;
