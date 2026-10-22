import type { NotificationChannel } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

// The event being handled - where it came from. Built by the consumer and
// passed to every handler.
export interface EventContext {
  eventType: string;
  eventVersion: number;
  // Producer-assigned id, when the envelope has one; otherwise topic/partition/offset identify the event.
  eventId?: string;
  topic: string;
  partition: number;
  offset: string;
}

// One notification on one channel. The channel module (src/channels/*) supplies
// `provider` and `send`; the handler supplies the rest.
export interface Delivery {
  channel: NotificationChannel;
  template: string;
  recipient: string;
  referenceId?: string;
  provider: string;
  // Throws NonRetryableError for a permanent rejection, anything else for a transient one.
  send: () => Promise<{ providerMessageId?: string }>;
}

export interface Skip {
  channel: NotificationChannel;
  template: string;
  recipient?: string | null;
  referenceId?: string;
  provider: string;
  reason: string;
}

// Same event + channel + recipient => same key, so a redelivered Kafka message
// maps to the row already written for it.
export function idempotencyKey(ctx: EventContext, channel: NotificationChannel, recipient: string | null | undefined) {
  const event = ctx.eventId ? `event:${ctx.eventId}` : `kafka:${ctx.topic}/${ctx.partition}/${ctx.offset}`;
  return `${event}:${channel}:${recipient ?? "-"}`;
}

function rowFor(ctx: EventContext, d: Omit<Delivery, "send"> | Skip) {
  return {
    idempotencyKey: idempotencyKey(ctx, d.channel, d.recipient),
    channel: d.channel,
    template: d.template,
    recipient: d.recipient ?? null,
    referenceId: d.referenceId ?? null,
    eventType: ctx.eventType,
    eventVersion: ctx.eventVersion,
    sourceTopic: ctx.topic,
    sourcePartition: ctx.partition,
    sourceOffset: ctx.offset,
    provider: d.provider,
  };
}

// Records and sends one notification, exactly once per event + channel + recipient
// as far as this service can tell:
//   - already SENT / SKIPPED  -> a redelivery; do nothing
//   - already FAILED          -> the provider refused it before; refuse again (dead-letter)
//   - new / PENDING           -> send, then mark SENT (or FAILED / leave PENDING)
// If Postgres is down, this throws before sending and Kafka redelivers - nothing
// goes out untracked. The one gap: a crash between the provider accepting and
// the SENT update means a redelivery sends it again.
export async function deliver(ctx: EventContext, d: Delivery): Promise<void> {
  const row = await prisma.notification.upsert({
    where: { idempotencyKey: idempotencyKey(ctx, d.channel, d.recipient) },
    create: rowFor(ctx, d),
    update: {},
  });
  const log = { notificationId: row.id, channel: d.channel, template: d.template, referenceId: d.referenceId };

  if (row.status === "SENT" || row.status === "SKIPPED") {
    logger.info({ ...log, status: row.status }, "notification already handled - duplicate delivery, not sending again");
    return;
  }
  if (row.status === "FAILED") {
    throw new NonRetryableError(`notification ${row.id} was permanently rejected earlier: ${row.statusReason}`);
  }

  let providerMessageId: string | undefined;
  try {
    ({ providerMessageId } = await d.send());
  } catch (err) {
    const permanent = err instanceof NonRetryableError;
    await prisma.notification
      .update({
        where: { id: row.id },
        data: { status: permanent ? "FAILED" : "PENDING", attempts: { increment: 1 }, statusReason: String((err as Error)?.message ?? err) },
      })
      .catch((dbErr) => logger.error({ ...log, err: dbErr }, "could not record failed notification"));
    throw err;
  }

  // It went out. Never throw from here on - that would redeliver and send it twice.
  await prisma.notification
    .update({
      where: { id: row.id },
      data: { status: "SENT", sentAt: new Date(), providerMessageId, attempts: { increment: 1 }, statusReason: null },
    })
    .catch((err) => logger.error({ ...log, err }, "notification sent but could not be marked SENT"));
}

// Records a notification we deliberately didn't send (no contact address, code
// expired), so "why didn't X get it?" has an answer in the table.
export async function recordSkipped(ctx: EventContext, s: Skip): Promise<void> {
  await prisma.notification.upsert({
    where: { idempotencyKey: idempotencyKey(ctx, s.channel, s.recipient) },
    create: { ...rowFor(ctx, s), status: "SKIPPED", statusReason: s.reason },
    update: {},
  });
}
