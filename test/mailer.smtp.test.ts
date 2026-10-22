import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SMTP mode: point the mailer at a configured host and replace nodemailer's
// transport, so we can script what the "server" answers.
const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail, close: vi.fn() })) },
}));
vi.mock("../src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/env")>();
  return { ...actual, env: { ...actual.env, smtp: { ...actual.env.smtp, host: "smtp.test" } } };
});

import { sendEmail } from "../src/lib/mailer";
import { NonRetryableError } from "../src/lib/errors";

const email = { to: "person@example.com", subject: "Hi", text: "t", html: "<p>t</p>" };
const smtpError = (code: string, responseCode?: number) =>
  Object.assign(new Error(`${code} ${responseCode ?? ""}`), { code, responseCode, response: `${responseCode} nope` });

describe("mailer in SMTP mode", () => {
  beforeEach(() => {
    sendMail.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("sends once when the server accepts, returning the SMTP Message-ID", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "<abc@uyir>" });
    await expect(sendEmail(email)).resolves.toEqual({ messageId: "<abc@uyir>" });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    sendMail.mockRejectedValueOnce(smtpError("ECONNECTION")).mockResolvedValueOnce({ messageId: "<retry@uyir>" });
    const sent = sendEmail(email);
    await vi.runAllTimersAsync();
    await expect(sent).resolves.toEqual({ messageId: "<retry@uyir>" });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent recipient rejection - throws NonRetryableError", async () => {
    sendMail.mockRejectedValue(smtpError("EENVELOPE", 550));
    await expect(sendEmail(email)).rejects.toBeInstanceOf(NonRetryableError);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("treats a 4xx envelope reply (mailbox busy, greylisting) as transient", async () => {
    sendMail.mockRejectedValue(smtpError("EENVELOPE", 451));
    const sent = sendEmail(email);
    const assertion = expect(sent).rejects.not.toBeInstanceOf(NonRetryableError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("treats an auth failure (our config, affects all mail) as transient, not dead-letter", async () => {
    sendMail.mockRejectedValue(smtpError("EAUTH", 535));
    const sent = sendEmail(email);
    const assertion = expect(sent).rejects.toThrow(/EAUTH/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(sendMail).toHaveBeenCalledTimes(3);
  });
});
