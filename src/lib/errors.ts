// A failure that will fail the same way however many times it is retried - a
// payload that doesn't match the schema, an SMTP server answering "no such
// mailbox". The consumer dead-letters these and moves on instead of letting
// Kafka redeliver them forever (which would block the partition behind them).
// Anything else thrown is treated as transient and redelivered.
export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}
