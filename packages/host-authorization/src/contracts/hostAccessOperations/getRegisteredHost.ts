/**
 * Contract for `HostAccessStore.getRegisteredHost`.
 *
 * Input: the registered host ID whose central existence must be proven.
 * Success: the matching `RegisteredHost` domain value directly.
 * Law: the returned host ID equals `input.hostId`.
 *
 * The platform implementation owns that input/output correlation. The
 * `RegisteredHost` schema validates the returned value itself; this operation does
 * not wrap it in a redundant single-field result DTO.
 */
import { Brand, Schema } from "effect";
import {
  HostAccessInvariantViolation,
  HostAccessStoreError,
  RegisteredHostNotFound,
} from "../hostAccessErrors.js";

/** Trusted store input identifying the registered host whose existence is required. */
export class GetRegisteredHostInput extends Schema.Class<
  GetRegisteredHostInput,
  Brand.Brand<"GetRegisteredHostInput">
>("GetRegisteredHostInput")({ hostId: Schema.NonEmptyString }) {}

/** Failures published by `HostAccessStore.getRegisteredHost`. */
export type GetRegisteredHostError =
  | RegisteredHostNotFound
  | HostAccessInvariantViolation
  | HostAccessStoreError;
