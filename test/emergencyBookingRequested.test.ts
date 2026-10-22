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
import { handleEmergencyBookingRequested } from "../src/handlers/emergencyBookingRequested";
import { NonRetryableError } from "../src/lib/errors";

const mockSend = vi.mocked(sendEmail);
const ctx: EventContext = { eventType: "EmergencyBookingRequested", eventVersion: 1, topic: "hospital.events", partition: 0, offset: "42" };
const mockDeliver = vi.mocked(deliver);
const mockSkip = vi.mocked(recordSkipped);

// Shape hospitalservice publishes (Jackson writes absent fields as null).
const validData = () => ({
  bookingId: "b1",
  hospitalId: "h1",
  hospitalName: "City Hospital",
  hospitalEmail: "er@city.test",
  patientName: "John Doe",
  patientPhone: "9999999999",
  emergencyType: "Cardiac Arrest",
  requestedAt: "2026-10-19T10:00:00Z",
});

describe("handleEmergencyBookingRequested", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emails the hospital with the emergency, patient phone and IST time", async () => {
    await handleEmergencyBookingRequested(validData(), ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toBe("er@city.test");
    expect(email.subject).toMatch(/emergency: cardiac arrest/i);
    expect(email.text).toContain("9999999999");
    expect(email.text).toContain("b1");
    expect(email.text).toContain("3:30"); // 10:00 UTC = 3:30 pm IST
    expect(email.html).toContain('href="tel:9999999999"');
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({
      channel: "EMAIL",
      template: "emergency_booking_requested",
      recipient: "er@city.test",
      referenceId: "b1",
    });
  });

  it("escapes patient-typed text in the HTML body", async () => {
    await handleEmergencyBookingRequested({ ...validData(), patientName: "<script>x</script>" }, ctx);

    const email = mockSend.mock.calls[0][0];
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("skips the email (no throw) when the hospital has no contact email, and records why", async () => {
    await expect(handleEmergencyBookingRequested({ ...validData(), hospitalEmail: null }, ctx)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSkip).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ channel: "EMAIL", referenceId: "b1", reason: expect.stringMatching(/no contact email/) }),
    );
  });

  it("still sends when the hospital name is missing", async () => {
    await handleEmergencyBookingRequested({ ...validData(), hospitalName: null }, ctx);

    expect(mockSend.mock.calls[0][0].text).toContain("your hospital");
  });

  it("rejects a malformed payload as non-retryable (dead-lettered), without sending", async () => {
    await expect(handleEmergencyBookingRequested({ bookingId: "b1" }, ctx)).rejects.toBeInstanceOf(NonRetryableError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a send failure so the message is redelivered", async () => {
    mockSend.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(handleEmergencyBookingRequested(validData(), ctx)).rejects.toThrow("SMTP down");
  });
});
