import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/mailer", () => ({
  sendEmail: vi.fn(async () => ({})),
  emailProvider: "smtp",
}));
// The ledger is tested in deliver.test.ts; here deliver() just sends.
vi.mock("../src/notifications/deliver", () => ({
  deliver: vi.fn(async (_ctx: unknown, d: { send: () => Promise<unknown> }) => {
    await d.send();
  }),
  recordSkipped: vi.fn(async () => {}),
}));
import { sendEmail } from "../src/lib/mailer";
import { deliver, recordSkipped, type EventContext } from "../src/notifications/deliver";
import { handlePasswordResetRequested } from "../src/handlers/passwordResetRequested";
import { NonRetryableError } from "../src/lib/errors";

const mockSend = vi.mocked(sendEmail);
const ctx: EventContext = { eventType: "PasswordResetRequested", eventVersion: 1, topic: "auth.events", partition: 0, offset: "42" };
const mockDeliver = vi.mocked(deliver);
const mockSkip = vi.mocked(recordSkipped);

const validData = () => ({
  userId: "user-1",
  email: "person@example.com",
  otp: "123456",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});

describe("handlePasswordResetRequested", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a reset email to the address in the event, with the code in the body", async () => {
    await handlePasswordResetRequested(validData(), ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toBe("person@example.com");
    expect(email.subject).toMatch(/uyir password reset code/i);
    expect(email.text).toContain("123456");
    expect(email.html).toContain("123456");
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({
      channel: "EMAIL",
      template: "password_reset",
      recipient: "person@example.com",
      referenceId: "user-1",
      provider: "smtp",
    });
  });

  it("rejects a malformed payload as non-retryable (dead-lettered), without sending", async () => {
    await expect(handlePasswordResetRequested({ email: "not-an-email" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric otp as non-retryable", async () => {
    await expect(handlePasswordResetRequested({ ...validData(), otp: "<b>12" }, ctx)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("skips (no send, no throw) when the code has already expired, and records why", async () => {
    const expired = { ...validData(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    await expect(handlePasswordResetRequested(expired, ctx)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSkip).toHaveBeenCalledWith(ctx, expect.objectContaining({ channel: "EMAIL", reason: expect.stringMatching(/expired/) }));
  });

  it("propagates a send failure so the message is redelivered", async () => {
    mockSend.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(handlePasswordResetRequested(validData(), ctx)).rejects.toThrow("SMTP down");
  });
});
