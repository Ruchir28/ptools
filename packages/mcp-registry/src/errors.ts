import { Data } from "effect";

export class McpConnectionError extends Data.TaggedError("McpConnectionError")<{
  readonly serverName: string;
  readonly cause: unknown;
}> {}

export class McpDiscoveryError extends Data.TaggedError("McpDiscoveryError")<{
  readonly serverName: string;
  readonly cause: unknown;
}> {}

export class McpCallError extends Data.TaggedError("McpCallError")<{
  readonly serverName: string;
  readonly toolName: string;
  readonly cause: unknown;
}> {}

export class UpstreamAuthRequired extends Data.TaggedError(
  "UpstreamAuthRequired",
)<{
  readonly serverName: string;
  readonly toolName: string;
  readonly authUrl?: string;
  readonly authorizeUrl?: string;
}> {}

export class ToolNotFound extends Data.TaggedError("ToolNotFound")<{
  readonly serverName: string;
  readonly toolName: string;
}> {}

export class InvalidToolArguments extends Data.TaggedError(
  "InvalidToolArguments",
)<{
  readonly serverName: string;
  readonly toolName: string;
  readonly value: unknown;
}> {}

export class NameCollisionError extends Data.TaggedError("NameCollisionError")<{
  readonly scope: string;
  readonly jsName: string;
  readonly originals: ReadonlyArray<string>;
}> {}
