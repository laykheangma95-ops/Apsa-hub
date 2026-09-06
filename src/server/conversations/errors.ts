export type ConversationErrorCode =
  | "conversation_not_found"
  | "message_not_found"
  | "permission_denied"
  | "invalid_cursor"
  | "customer_not_found"
  | "invalid_assignment"
  | "stale_state"
  | "invalid_reference"
  | "conversation_unavailable";

export class ConversationError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ConversationErrorCode) {
    super(code);
    this.name = "ConversationError";
    this.statusCode =
      code === "permission_denied"
        ? 403
        : code.endsWith("not_found")
          ? 404
          : code === "stale_state"
            ? 409
            : code === "conversation_unavailable"
              ? 503
              : 400;
  }
}

/** Never send PG details, SQL, or provider payloads to the client. */
export function databaseError(error: unknown): ConversationError {
  const message = (error as { message?: string })?.message;
  const codes: ConversationErrorCode[] = [
    "conversation_not_found",
    "message_not_found",
    "permission_denied",
    "invalid_assignment",
    "stale_state",
    "invalid_reference",
  ];
  return new ConversationError(
    codes.includes(message as ConversationErrorCode)
      ? (message as ConversationErrorCode)
      : "conversation_unavailable",
  );
}
