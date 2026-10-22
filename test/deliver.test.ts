import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the notifications table: just enough of upsert/update
// (unique on idempotencyKey) to exercise deliver()'s state machine. The same
// behaviour against real Postgres is in deliver.db.test.ts.
type Row = Record<string, any>;
const rows = new Map<string, Row>();
let failNextUpdate = false;

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    notification: {
      upsert: vi.fn(async ({ where, create }: { where: { idempotencyKey: string }; create: Row }) => {
        const existing = rows.get(where.idempotencyKey);
        if (existing) return existing;
        const row: Row = { id: `n${rows.size + 1}`, status: "PENDING", attempts: 0, statusReason: null, ...create };
        rows.set(row.idempotencyKey, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          throw new Error("db blip");
        }
        const row = [...rows.values()].find((r) => r.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          row[k] = v && typeof v === "object" && "increment" in v ? row[k] + v.increment : v;
        }
        return row;
      }),
    },
  },
}));

import { deliver, recordSkipped, idempotencyKey, type Delivery, type EventContext } from "../src/notifications/deliver";
import { NonRetryableError } from "../src/lib/errors";

const ctx: EventContext = { eventType: "E", eventVersion: 1, topic: "t", partition: 0, offset: "7" };
const delivery = (send: Delivery["send"] = async () => ({ providerMessageId: "<m1@smtp>" })): Delivery => ({
  channel: "EMAIL",
  template: "tpl",
  recipient: "a@b.c",
  referenceId: "ref-1",
  provider: "smtp",
  send: vi.fn(send),
});
const only = () => [...rows.values()][0];

beforeEach(() => {
  rows.clear();
  failNextUpdate = false;
});

describe("idempotencyKey", () => {
  it("uses Kafka coordinates when the event has no id", () => {
    expect(idempotencyKey(ctx, "EMAIL", "a@b.c")).toBe("kafka:t/0/7:EMAIL:a@b.c");
  });

  it("prefers the producer's eventId, and differs per channel and recipient", () => {
    const withId = { ...ctx, eventId: "evt-1" };
    expect(idempotencyKey(withId, "SMS", "+919999999999")).toBe("event:evt-1:SMS:+919999999999");
    expect(idempotencyKey(withId, "EMAIL", "a@b.c")).not.toBe(idempotencyKey(withId, "WHATSAPP", "a@b.c"));
  });
});

describe("deliver", () => {
  it("sends and records SENT with the provider's message id", async () => {
    const d = delivery();
    await deliver(ctx, d);

    expect(d.send).toHaveBeenCalledTimes(1);
    expect(only()).toMatchObject({
      status: "SENT",
      channel: "EMAIL",
      template: "tpl",
      recipient: "a@b.c",
      referenceId: "ref-1",
      sourceTopic: "t",
      sourceOffset: "7",
      providerMessageId: "<m1@smtp>",
      attempts: 1,
    });
    expect(only().sentAt).toBeInstanceOf(Date);
  });

  it("does not send again when the same message is redelivered", async () => {
    await deliver(ctx, delivery());
    const again = delivery();
    await deliver(ctx, again);

    expect(again.send).not.toHaveBeenCalled();
    expect(rows.size).toBe(1);
  });

  it("leaves a transient failure PENDING and rethrows, then sends on redelivery", async () => {
    await expect(
      deliver(
        ctx,
        delivery(async () => {
          throw new Error("SMTP down");
        }),
      ),
    ).rejects.toThrow("SMTP down");
    expect(only()).toMatchObject({ status: "PENDING", attempts: 1, statusReason: "SMTP down" });

    await deliver(ctx, delivery());
    expect(only()).toMatchObject({ status: "SENT", attempts: 2, statusReason: null });
  });

  it("marks a permanent rejection FAILED, and refuses it again on redelivery without sending", async () => {
    const rejected = delivery(async () => {
      throw new NonRetryableError("550 no such mailbox");
    });
    await expect(deliver(ctx, rejected)).rejects.toBeInstanceOf(NonRetryableError);
    expect(only()).toMatchObject({ status: "FAILED", statusReason: "550 no such mailbox" });

    const again = delivery();
    await expect(deliver(ctx, again)).rejects.toBeInstanceOf(NonRetryableError);
    expect(again.send).not.toHaveBeenCalled();
  });

  it("does not throw (and so does not resend) if marking SENT fails after the send went out", async () => {
    failNextUpdate = true;
    await expect(deliver(ctx, delivery())).resolves.toBeUndefined();
  });
});

describe("recordSkipped", () => {
  it("records why nothing was sent, and is idempotent", async () => {
    const skip = { channel: "EMAIL" as const, template: "tpl", referenceId: "b1", provider: "smtp", reason: "no contact email" };
    await recordSkipped(ctx, skip);
    await recordSkipped(ctx, skip);

    expect(rows.size).toBe(1);
    expect(only()).toMatchObject({ status: "SKIPPED", recipient: null, statusReason: "no contact email" });
  });

  it("stops a later deliver() for the same key from sending", async () => {
    await recordSkipped(ctx, { channel: "EMAIL", template: "tpl", recipient: "a@b.c", provider: "smtp", reason: "expired" });
    const d = delivery();
    await deliver(ctx, d);
    expect(d.send).not.toHaveBeenCalled();
  });
});
