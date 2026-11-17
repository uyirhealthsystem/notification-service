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
import { deliver, type EventContext } from "../src/notifications/deliver";
import { handleUserLoggedIn } from "../src/handlers/userLoggedIn";
import { processMessage } from "../src/kafka/consumer";
import { NonRetryableError } from "../src/lib/errors";

const mockSend = vi.mocked(sendEmail);
const mockDeliver = vi.mocked(deliver);
const ctx: EventContext = { eventType: "UserLoggedIn", eventVersion: 1, topic: "auth.events", partition: 0, offset: "7" };

const validData = () => ({
  userId: "user-1",
  email: "person@example.com",
  role: "PATIENT",
  portalId: "patient-app",
  portalName: "Patient App",
  method: "PASSWORD" as const,
  ip: "203.0.113.5",
  userAgent: "UyirApp/1.0 (Android 14)",
  loggedInAt: "2026-11-17T09:30:00.000Z",
});

describe("handleUserLoggedIn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emails a sign-in alert with time (IST), app, method, device and IP", async () => {
    await handleUserLoggedIn(validData(), ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toBe("person@example.com");
    expect(email.subject).toMatch(/new sign-in/i);
    expect(email.text).toContain("3:00 pm IST");
    expect(email.text).toContain("Patient App");
    expect(email.text).toContain("Email and password");
    expect(email.text).toContain("UyirApp/1.0 (Android 14)");
    expect(email.text).toContain("203.0.113.5");
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({
      channel: "EMAIL",
      template: "login_alert",
      recipient: "person@example.com",
      referenceId: "user-1",
    });
  });

  it("leaves out device / IP lines when they're unknown", async () => {
    await handleUserLoggedIn({ ...validData(), method: "GOOGLE", ip: null, userAgent: null }, ctx);
    const email = mockSend.mock.calls[0][0];
    expect(email.text).toContain("Google");
    expect(email.text).not.toContain("IP address");
    expect(email.text).not.toContain("Device");
  });

  it("escapes HTML in the user agent", async () => {
    await handleUserLoggedIn({ ...validData(), userAgent: "<script>x</script>" }, ctx);
    expect(mockSend.mock.calls[0][0].html).not.toContain("<script>");
  });

  it("rejects a malformed payload as non-retryable, without sending", async () => {
    await expect(handleUserLoggedIn({ email: "nope" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("is wired into the consumer for UserLoggedIn v1", async () => {
    const deadLetter = vi.fn(async () => {});
    const raw = JSON.stringify({ eventType: "UserLoggedIn", eventVersion: 1, occurredAt: new Date().toISOString(), data: validData() });
    await processMessage(raw, { topic: "auth.events", partition: 0, offset: "8" }, deadLetter);
    expect(deadLetter).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
