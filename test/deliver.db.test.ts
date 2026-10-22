import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma";
import { deliver, recordSkipped, type Delivery, type EventContext } from "../src/notifications/deliver";
import { NonRetryableError } from "../src/lib/errors";

// Runs against a real Postgres with the migrations applied - CI provides one;
// locally:  TEST_DATABASE_URL=postgresql://... npx prisma migrate deploy && npm test
// (test/setup.ts points DATABASE_URL at TEST_DATABASE_URL.) Every row it writes
// is under a unique topic and deleted afterwards.
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const topic = `test.${process.pid}.${Date.now()}`;
let offset = 0;
const nextCtx = (): EventContext => ({ eventType: "E", eventVersion: 1, topic, partition: 0, offset: String(++offset) });

const delivery = (send: Delivery["send"]): Delivery => ({
  channel: "EMAIL",
  template: "tpl",
  recipient: "a@b.c",
  referenceId: "ref-db",
  provider: "smtp",
  send,
});
const rowsFor = (ctx: EventContext) => prisma.notification.findMany({ where: { sourceTopic: topic, sourceOffset: ctx.offset } });

// A remote database (e.g. Neon in another region) costs a few hundred ms per
// query, and a test here makes up to ~15 - well past vitest's 5s default.
describe.skipIf(!enabled)("deliver() against Postgres", { timeout: 30_000 }, () => {
  beforeAll(() => prisma.$connect());
  beforeEach(() => prisma.notification.deleteMany({ where: { sourceTopic: topic } }));
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { sourceTopic: topic } });
    await prisma.$disconnect();
  });

  it("writes one SENT row, and a redelivery doesn't send or add a row", async () => {
    const ctx = nextCtx();
    let sends = 0;
    const send = async () => {
      sends++;
      return { providerMessageId: "<id@db>" };
    };

    await deliver(ctx, delivery(send));
    await deliver(ctx, delivery(send));

    const rows = await rowsFor(ctx);
    expect(sends).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", channel: "EMAIL", providerMessageId: "<id@db>", attempts: 1 });
    expect(rows[0].sentAt).toBeInstanceOf(Date);
  });

  it("two concurrent deliveries of the same message produce a single row", async () => {
    const ctx = nextCtx();
    const send = async () => ({});
    await Promise.allSettled([deliver(ctx, delivery(send)), deliver(ctx, delivery(send))]);

    expect(await rowsFor(ctx)).toHaveLength(1);
  });

  it("records PENDING on a transient failure and FAILED on a permanent one", async () => {
    const transient = nextCtx();
    await expect(
      deliver(
        transient,
        delivery(async () => {
          throw new Error("SMTP down");
        }),
      ),
    ).rejects.toThrow();
    expect((await rowsFor(transient))[0]).toMatchObject({ status: "PENDING", attempts: 1, statusReason: "SMTP down" });

    const permanent = nextCtx();
    await expect(
      deliver(
        permanent,
        delivery(async () => {
          throw new NonRetryableError("550 no such mailbox");
        }),
      ),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect((await rowsFor(permanent))[0]).toMatchObject({ status: "FAILED", statusReason: "550 no such mailbox" });
  });

  it("stores the non-email channels too", async () => {
    const ctx = nextCtx();
    for (const channel of ["SMS", "PUSH", "WHATSAPP"] as const) {
      await deliver(ctx, { ...delivery(async () => ({})), channel, recipient: `${channel}-recipient` });
    }
    await recordSkipped(ctx, { channel: "EMAIL", template: "tpl", provider: "smtp", reason: "no contact email" });

    const rows = await rowsFor(ctx);
    expect(rows.map((r) => `${r.channel}:${r.status}`).sort()).toEqual([
      "EMAIL:SKIPPED",
      "PUSH:SENT",
      "SMS:SENT",
      "WHATSAPP:SENT",
    ]);
  });
});
