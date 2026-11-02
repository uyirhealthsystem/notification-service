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
import { deliver, type EventContext } from "../src/notifications/deliver";
import { handleFollowUpReminderDue } from "../src/handlers/followUpReminderDue";
import { NonRetryableError } from "../src/lib/errors";

const mockSend = vi.mocked(sendEmail);
const mockDeliver = vi.mocked(deliver);
const ctx: EventContext = { eventType: "FollowUpReminderDue", eventVersion: 1, topic: "hospital.events", partition: 0, offset: "7" };

// Shape hospitalservice publishes (Jackson writes absent fields as null).
const validData = () => ({
  appointmentId: "a1",
  reminderType: "UPCOMING",
  patientId: "p1",
  patientName: "Ravi Kumar",
  patientEmail: "ravi@test.in",
  hospitalId: "h1",
  hospitalName: "City Care",
  hospitalPhone: "044-1234",
  doctorId: "d1",
  doctorName: "Dr. Meena",
  dueDate: "2026-11-12",
  bookableFrom: "2026-11-09",
  bookableUntil: "2026-11-19",
  instructions: "Bring your blood test report",
});

describe("handleFollowUpReminderDue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emails the patient the due date, booking window and the doctor's instructions", async () => {
    await handleFollowUpReminderDue(validData(), ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toBe("ravi@test.in");
    expect(email.subject).toMatch(/reminder: follow-up with dr\. meena due on 12 nov 2026/i);
    expect(email.text).toContain("Bring your blood test report");
    expect(email.text).toContain("9 Nov 2026");
    expect(email.text).toContain("19 Nov 2026");
    expect(email.html).toContain('href="tel:044-1234"');
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({
      channel: "EMAIL",
      template: "follow_up_reminder",
      recipient: "ravi@test.in",
      referenceId: "a1:UPCOMING",
    });
  });

  it("says 'due today' for the DUE_TODAY reminder", async () => {
    await handleFollowUpReminderDue({ ...validData(), reminderType: "DUE_TODAY" }, ctx);

    const email = mockSend.mock.calls[0][0];
    expect(email.subject).toMatch(/due today/i);
    expect(email.text).toContain("is due today");
  });

  it("still sends without instructions, names or phone", async () => {
    await handleFollowUpReminderDue(
      { ...validData(), instructions: null, hospitalName: null, doctorName: null, hospitalPhone: null },
      ctx,
    );

    const email = mockSend.mock.calls[0][0];
    expect(email.text).toContain("your doctor at the hospital");
    expect(email.text).not.toContain("instructions");
    expect(email.html).not.toContain("tel:");
  });

  it("escapes hospital-typed instructions in the HTML body", async () => {
    await handleFollowUpReminderDue({ ...validData(), instructions: "<script>x</script>" }, ctx);

    const email = mockSend.mock.calls[0][0];
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("rejects a malformed payload as non-retryable, without sending", async () => {
    await expect(handleFollowUpReminderDue({ ...validData(), patientEmail: "nope" }, ctx)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    await expect(handleFollowUpReminderDue({ ...validData(), reminderType: "LATER" }, ctx)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a send failure so the message is redelivered", async () => {
    mockSend.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(handleFollowUpReminderDue(validData(), ctx)).rejects.toThrow("SMTP down");
  });
});
