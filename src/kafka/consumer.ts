import { Kafka, Consumer, Producer, KafkaConfig } from "kafkajs";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";
import { envelopeSchema, Envelope } from "../events/schema";
import { handlePasswordResetRequested } from "../handlers/passwordResetRequested";
import { handleEmergencyBookingRequested } from "../handlers/emergencyBookingRequested";
import { setConsumerState } from "./status";
import type { EventContext } from "../notifications/deliver";

export interface EventHandler {
  version: number;
  handle: (data: unknown, ctx: EventContext) => Promise<void>;
}

// eventType -> handler for the one eventVersion it understands. Add a row here
// (and a schema + template) for each new event this service should act on.
// Event types not listed belong to other consumers and are skipped.
export const handlers: Record<string, EventHandler> = {
  PasswordResetRequested: { version: 1, handle: handlePasswordResetRequested },
  EmergencyBookingRequested: { version: 1, handle: handleEmergencyBookingRequested },
};

export type DeadLetter = (reason: string, details?: unknown) => Promise<void>;
export type MessageSource = Pick<EventContext, "topic" | "partition" | "offset">;

// One message, start to finish. Returns when the message is done with - handled,
// skipped, or dead-lettered - so its offset can be committed. Throws only for a
// transient failure, so kafkajs keeps the offset and redelivers.
export async function processMessage(
  raw: string | undefined,
  source: MessageSource,
  deadLetter: DeadLetter,
  registry: Record<string, EventHandler> = handlers,
): Promise<void> {
  if (!raw) return;

  let envelope: Envelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(raw));
  } catch (err) {
    await deadLetter("unparseable event", String(err));
    return;
  }

  const handler = registry[envelope.eventType];
  if (!handler) {
    logger.debug({ eventType: envelope.eventType }, "no handler for event type, skipping");
    return;
  }
  // A v2 payload validated against the v1 schema would fail (or worse, half-pass).
  // Park it until this service learns the new version.
  if (envelope.eventVersion !== handler.version) {
    await deadLetter(`unsupported ${envelope.eventType} version ${envelope.eventVersion} (expected ${handler.version})`);
    return;
  }

  try {
    await handler.handle(envelope.data, {
      ...source,
      eventType: envelope.eventType,
      eventVersion: envelope.eventVersion,
      eventId: envelope.eventId,
    });
  } catch (err) {
    if (err instanceof NonRetryableError) {
      await deadLetter(err.message, err.details);
      return;
    }
    throw err;
  }
}

// Password-reset codes must not outlive auth.events' 1h retention by sitting in
// the DLQ. Dead-lettered copies are for diagnosis; the code itself is useless
// by the time anyone looks.
export function redactSecrets(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.data && typeof parsed.data === "object" && "otp" in parsed.data) {
      parsed.data.otp = "[redacted]";
      return JSON.stringify(parsed);
    }
  } catch {
    // Not JSON - nothing structured to redact.
  }
  return raw;
}

function kafkaConfig(): KafkaConfig {
  const { sasl } = env.kafka;
  return {
    clientId: env.kafka.clientId,
    brokers: env.kafka.brokers,
    ssl: env.kafka.ssl || undefined,
    sasl: sasl ? ({ mechanism: sasl.mechanism, username: sasl.username, password: sasl.password } as KafkaConfig["sasl"]) : undefined,
    // A brand-new cluster may not have the topic yet on first boot.
    retry: { retries: 8 },
  };
}

// kafkajs heartbeats between messages. A send that waits out SMTP timeouts and
// retries can take longer than the 30s session timeout, which would get this
// consumer kicked from the group mid-send (and the email sent twice). heartbeat()
// is a no-op until heartbeatInterval has passed, so calling it often is cheap.
const HEARTBEAT_EVERY_MS = 3_000;

let consumer: Consumer | undefined;
let producer: Producer | undefined;

export async function startConsumer(): Promise<void> {
  const kafka = new Kafka(kafkaConfig());

  producer = kafka.producer();
  await producer.connect();
  const dlqProducer = producer;

  consumer = kafka.consumer({ groupId: env.kafka.groupId });
  const c = consumer;
  c.on(c.events.GROUP_JOIN, () => setConsumerState("running"));
  c.on(c.events.STOP, () => setConsumerState("stopped"));
  c.on(c.events.CRASH, ({ payload }) => {
    logger.error({ err: payload.error, restart: payload.restart }, "kafka consumer crashed");
    if (payload.restart) {
      setConsumerState("restarting");
      return;
    }
    // kafkajs gave up. Exit so systemd / Docker restarts the process rather than
    // leaving an HTTP server up with nothing consuming.
    setConsumerState("stopped");
    logger.fatal("kafka consumer will not restart itself - exiting");
    process.exit(1);
  });

  await c.connect();
  for (const topic of env.kafka.topics) {
    await c.subscribe({ topic, fromBeginning: false });
  }
  logger.info({ topics: env.kafka.topics, groupId: env.kafka.groupId, dlq: env.kafka.dlqTopic }, "kafka consumer started");

  await c.run({
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
      const raw = message.value?.toString();

      const deadLetter: DeadLetter = async (reason, details) => {
        logger.warn({ topic, partition, offset: message.offset, reason, details }, "dead-lettering message");
        // If this send fails it throws, the offset isn't committed, and the
        // message is retried - better than dropping it.
        await dlqProducer.send({
          topic: env.kafka.dlqTopic,
          messages: [
            {
              key: message.key,
              value: JSON.stringify({
                failedAt: new Date().toISOString(),
                reason,
                details,
                source: { topic, partition, offset: message.offset },
                payload: raw === undefined ? null : redactSecrets(raw),
              }),
            },
          ],
        });
      };

      const beat = setInterval(() => {
        heartbeat().catch((err) => logger.debug({ err }, "heartbeat failed"));
      }, HEARTBEAT_EVERY_MS);
      try {
        await processMessage(raw, { topic, partition, offset: message.offset }, deadLetter);
      } finally {
        clearInterval(beat);
      }
    },
  });
}

export async function stopConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect().catch((err) => logger.error({ err }, "error disconnecting consumer"));
    consumer = undefined;
  }
  if (producer) {
    await producer.disconnect().catch((err) => logger.error({ err }, "error disconnecting producer"));
    producer = undefined;
  }
  setConsumerState("stopped");
}
