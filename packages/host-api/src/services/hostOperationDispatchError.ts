/** Shared failure contract for reaching a selected host instance. */
import { Data } from "effect";

/** Failure to resolve or reach a selected host instance. */
export class HostOperationDispatchError extends Data.TaggedError(
  "HostOperationDispatchError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
