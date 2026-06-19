import type {
  HostToSandboxMessage,
  SandboxToHostMessage,
} from "@ptools/executor";
import {
  HostToSandboxMessage as HostToSandboxMessageSchema,
  SandboxToHostMessage as SandboxToHostMessageSchema,
  ExecutorProtocolError,
} from "@ptools/executor";
import { Effect, Schema } from "effect";

export const MAX_SANDBOX_FRAME_BYTES = 1024 * 1024;

/** Encodes one host message as one bounded NDJSON frame. */
export const encodeHostMessage = (
  message: HostToSandboxMessage,
): Effect.Effect<string, ExecutorProtocolError> =>
  Schema.decodeUnknown(HostToSandboxMessageSchema)(message).pipe(
    Effect.flatMap((validated) =>
      Effect.try({
        try: () => {
          const frame = `${JSON.stringify(validated)}\n`;
          if (Buffer.byteLength(frame) > MAX_SANDBOX_FRAME_BYTES) {
            throw new Error("Host sandbox protocol frame exceeds size limit");
          }
          return frame;
        },
        catch: (cause) =>
          new ExecutorProtocolError({
            message: "Failed to encode host sandbox protocol frame",
            cause,
          }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof ExecutorProtocolError
        ? cause
        : new ExecutorProtocolError({
            message: "Invalid host sandbox protocol message",
            cause,
          }),
    ),
  );

/** Parses and validates one untrusted NDJSON frame from the subprocess. */
export const decodeSandboxMessage = (
  line: string,
): Effect.Effect<SandboxToHostMessage, ExecutorProtocolError> =>
  Effect.try({
    try: () => {
      if (Buffer.byteLength(line) > MAX_SANDBOX_FRAME_BYTES) {
        throw new Error("Sandbox protocol frame exceeds size limit");
      }
      return JSON.parse(line) as unknown;
    },
    catch: (cause) =>
      new ExecutorProtocolError({
        message: "Sandbox emitted malformed JSON",
        cause,
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(SandboxToHostMessageSchema)),
    Effect.mapError((cause) =>
      cause instanceof ExecutorProtocolError
        ? cause
        : new ExecutorProtocolError({
            message: "Sandbox emitted an invalid protocol message",
            cause,
          }),
    ),
  );
