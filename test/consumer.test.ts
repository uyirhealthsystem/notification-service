import { describe, it, expect, vi } from "vitest";
import { processMessage, redactSecrets, EventHandler } from "../src/kafka/consumer";
import { NonRetryableError } from "../src/lib/errors";

const event = (eventType: string, eventVersion = 1, data: unknown = {}) =>
  JSON.stringify({ eventType, eventVersion, occurredAt: "2026-10-21T00:00:00Z", data });

const source = { topic: "auth.events", partition: 3, offset: "17" };

function setup(handle: EventHandler["handle"] = vi.fn(async () => {})) {
  const deadLetter = vi.fn(async () => {});
  const registry = { Known: { version: 1, handle } };
  return { deadLetter, registry, handle };
}

describe("processMessage", () => {
  it("passes the event data to the matching handler", async () => {
    const { deadLetter, registry, handle } = setup();
    await processMessage(event("Known", 1, { a: 1 }), source, deadLetter, registry);

    expect(handle).toHaveBeenCalledWith(
      { a: 1 },
      { topic: "auth.events", partition: 3, offset: "17", eventType: "Known", eventVersion: 1, eventId: undefined },
    );
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("passes a producer-supplied eventId through to the handler", async () => {
    const { deadLetter, registry, handle } = setup();
    const raw = JSON.stringify({ eventId: "evt-9", eventType: "Known", eventVersion: 1, occurredAt: "x", data: {} });
    await processMessage(raw, source, deadLetter, registry);

    expect(handle).toHaveBeenCalledWith({}, expect.objectContaining({ eventId: "evt-9" }));
  });

  it("skips event types it has no handler for (they belong to other consumers)", async () => {
    const { deadLetter, registry, handle } = setup();
    await processMessage(event("SomeoneElses"), source, deadLetter, registry);

    expect(handle).not.toHaveBeenCalled();
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("dead-letters a message that isn't a valid envelope", async () => {
    const { deadLetter, registry } = setup();
    await processMessage("not json", source, deadLetter, registry);

    expect(deadLetter).toHaveBeenCalledWith("unparseable event", expect.any(String));
  });

  it("dead-letters an event version the handler doesn't understand", async () => {
    const { deadLetter, registry, handle } = setup();
    await processMessage(event("Known", 2), source, deadLetter, registry);

    expect(handle).not.toHaveBeenCalled();
    expect(deadLetter).toHaveBeenCalledWith(expect.stringMatching(/unsupported Known version 2/));
  });

  it("dead-letters a NonRetryableError instead of letting Kafka redeliver it", async () => {
    const { deadLetter, registry } = setup(async () => {
      throw new NonRetryableError("mailbox does not exist", { code: 550 });
    });

    await expect(processMessage(event("Known"), source, deadLetter, registry)).resolves.toBeUndefined();
    expect(deadLetter).toHaveBeenCalledWith("mailbox does not exist", { code: 550 });
  });

  it("rethrows a transient error so the offset isn't committed", async () => {
    const { deadLetter, registry } = setup(async () => {
      throw new Error("SMTP down");
    });

    await expect(processMessage(event("Known"), source, deadLetter, registry)).rejects.toThrow("SMTP down");
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("rethrows when the dead-letter publish itself fails, so nothing is dropped", async () => {
    const { registry } = setup();
    const deadLetter = vi.fn(async () => {
      throw new Error("kafka down");
    });

    await expect(processMessage("not json", source, deadLetter, registry)).rejects.toThrow("kafka down");
  });
});

describe("redactSecrets", () => {
  it("replaces a password-reset code before the event is parked in the DLQ", () => {
    const out = JSON.parse(redactSecrets(event("PasswordResetRequested", 1, { email: "a@b.c", otp: "123456" })));
    expect(out.data).toEqual({ email: "a@b.c", otp: "[redacted]" });
  });

  it("leaves other payloads (and non-JSON) untouched", () => {
    const raw = event("EmergencyBookingRequested", 1, { bookingId: "b1" });
    expect(redactSecrets(raw)).toBe(raw);
    expect(redactSecrets("not json")).toBe("not json");
  });
});
