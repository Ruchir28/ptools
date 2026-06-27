/**
 * Derived helper types for Code Mode operation names and log levels.
 *
 * These types are intentionally derived from the schema-owned DTOs so operation
 * discriminators and log-level strings have one source of truth.
 */
import type { CapturedLog, CodeModeRequest } from "./contracts/index.js";

/** Operation discriminator for Code Mode requests, derived from the request schema. */
export type CodeModeOperation = CodeModeRequest["operation"];

/** Code Mode operations that map to user-callable tools. */
export type CodeModeToolName = Exclude<
  CodeModeOperation,
  "auth_status" | "refresh"
>;

/** Log level emitted by Code Mode execution logs. */
export type LogLevel = CapturedLog["level"];
