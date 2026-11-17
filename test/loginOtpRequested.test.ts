import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/mailer", () => ({
  sendEmail: vi.fn(async () => ({})),
  emailProvider: "smtp",
}));
vi.mock("../src/notifications/deliver", () => ({
  deliver: vi.fn(async (_ctx: unknown, d: { send: () => Promise<unknown> }) => {
    await d.send();
  }),
  recordSkipped: vi.fn(async () => {}),
}));
import { sendEmail } from "../src/lib/mailer";
import { deliver, recordSkipped, type EventContext } from "../src/notifications/deliver";
import { handleLoginOtpRequested } from "../src/handlers/loginOtpRequested";
import { processMessage, redactSecrets } from "../src/kafka/consumer";
import { NonRetryableError } from "../src/lib/errors";

const mockSend = vi.mocked(sendEmail);
const mockDeliver = vi.mocked(deliver);
const mockSkip = vi.mocked(recordSkipped);
const ctx: EventContext = { eventType: "LoginOtpRequested", eventVersion: 1, topic: "auth.events", partition: 0, offset: "3" };

const validData = () => ({
  userId: "user-1",
  email: "person@example.com",
  otp: "482913",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  portalName: "Patient App",
  ip: "203.0.113.5",
  userAgent: "UyirApp/1.0 (Android 14)",
});

describe("handleLoginOtpRequested", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emails the sign-in code (in subject and body) to the user", async () => {
    await handleLoginOtpRequested(validData(), ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toBe("person@example.com");
    expect(email.subject).toBe("482913 is your Uyir sign-in code");
    expect(email.text).toContain("482913");
    expect(email.html).toContain("482913");
    expect(email.text).toContain("Patient App");
    expect(email.text).toMatch(/expires in 5 minutes/);
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({
      channel: "EMAIL",
      template: "login_otp",
      recipient: "person@example.com",
      referenceId: "user-1",
    });
  });

  it("does not send an already-expired code (records a skip instead)", async () => {
    await handleLoginOtpRequested({ ...validData(), expiresAt: new Date(Date.now() - 1000).toISOString() }, ctx);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSkip).toHaveBeenCalledTimes(1);
  });

  it("escapes HTML in the user agent", async () => {
    await handleLoginOtpRequested({ ...validData(), userAgent: "<img src=x onerror=alert(1)>" }, ctx);
    expect(mockSend.mock.calls[0][0].html).not.toContain("<img");
  });

  it("rejects a malformed payload / non-numeric code as non-retryable", async () => {
    await expect(handleLoginOtpRequested({ email: "x" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(handleLoginOtpRequested({ ...validData(), otp: "12ab56" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("is wired into the consumer for LoginOtpRequested v1", async () => {
    const deadLetter = vi.fn(async () => {});
    const raw = JSON.stringify({ eventType: "LoginOtpRequested", eventVersion: 1, occurredAt: new Date().toISOString(), data: validData() });
    await processMessage(raw, { topic: "auth.events", partition: 0, offset: "4" }, deadLetter);
    expect(deadLetter).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("the code is redacted if the event is ever dead-lettered", () => {
    const raw = JSON.stringify({ eventType: "LoginOtpRequested", eventVersion: 1, occurredAt: "x", data: validData() });
    expect(redactSecrets(raw)).not.toContain("482913");
  });
});
