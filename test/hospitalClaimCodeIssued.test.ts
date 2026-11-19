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
import { handleHospitalClaimCodeIssued } from "../src/handlers/hospitalClaimCodeIssued";
import { NonRetryableError } from "../src/lib/errors";
import { handlers } from "../src/kafka/consumer";

const mockSend = vi.mocked(sendEmail);
const mockDeliver = vi.mocked(deliver);
const ctx: EventContext = { eventType: "HospitalClaimCodeIssued", eventVersion: 1, topic: "hospital.events", partition: 0, offset: "3" };

// Shape hospitalservice publishes (Instant.toString() for expiresAt).
const validData = () => ({
  hospitalId: "6740c2f1a91b",
  hospitalName: "City Care Hospital",
  email: "admin@citycare.in",
  claimCode: "K7P4-QX2M",
  expiresAt: "2026-11-26T10:00:00.123456Z",
  reason: "INITIAL",
});

describe("handleHospitalClaimCodeIssued", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is registered for hospital.events v1", () => {
    expect(handlers.HospitalClaimCodeIssued?.version).toBe(1);
  });

  it("emails the hospital its id, the claim code, the expiry and how to link", async () => {
    await handleHospitalClaimCodeIssued(validData(), ctx);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toBe("admin@citycare.in");
    expect(email.subject).toBe("Link City Care Hospital to your Uyir account");
    for (const body of [email.text, email.html]) {
      expect(body).toContain("6740c2f1a91b");
      expect(body).toContain("K7P4-QX2M");
      expect(body).toContain("26 Nov 2026");
    }
    expect(email.text).toContain("register (or log in) as a Hospital");
    expect(mockDeliver.mock.calls[0][1]).toMatchObject({
      channel: "EMAIL",
      template: "hospital_claim_code",
      recipient: "admin@citycare.in",
      referenceId: "6740c2f1a91b:2026-11-26T10:00:00.123456Z",
    });
  });

  it("says the old code no longer works on a RESEND", async () => {
    await handleHospitalClaimCodeIssued({ ...validData(), reason: "RESEND" }, ctx);

    const email = mockSend.mock.calls[0][0];
    expect(email.subject).toBe("New claim code for City Care Hospital on Uyir");
    expect(email.text).toContain("Any earlier code no longer works");
  });

  it("still sends without a hospital name", async () => {
    await handleHospitalClaimCodeIssued({ ...validData(), hospitalName: null }, ctx);

    expect(mockSend.mock.calls[0][0].subject).toBe("Link your hospital to your Uyir account");
  });

  it("escapes the PRO-typed hospital name in the HTML body", async () => {
    await handleHospitalClaimCodeIssued({ ...validData(), hospitalName: "<b>Evil</b>" }, ctx);

    const email = mockSend.mock.calls[0][0];
    expect(email.html).not.toContain("<b>Evil</b>");
    expect(email.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });

  it("rejects a malformed payload as non-retryable, without sending or echoing the code", async () => {
    const bad = [{ ...validData(), email: "nope" }, { ...validData(), reason: "LATER" }, { ...validData(), expiresAt: "soon" }];
    for (const payload of bad) {
      const error = await handleHospitalClaimCodeIssued(payload, ctx).catch((e) => e);
      expect(error).toBeInstanceOf(NonRetryableError);
      expect(JSON.stringify(error)).not.toContain("K7P4-QX2M");
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a send failure so the message is redelivered", async () => {
    mockSend.mockRejectedValueOnce(new Error("SMTP down"));
    await expect(handleHospitalClaimCodeIssued(validData(), ctx)).rejects.toThrow("SMTP down");
  });
});
