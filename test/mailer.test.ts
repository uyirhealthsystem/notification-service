import { describe, it, expect, vi } from "vitest";
import { sendEmail } from "../src/lib/mailer";
import { logger } from "../src/lib/logger";

// SMTP_HOST is unset in test/setup.ts, so the mailer is in log mode: it should
// log the email and resolve without touching nodemailer.
describe("mailer in log mode (no SMTP configured)", () => {
  it("logs the email instead of sending and does not throw", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await expect(
      sendEmail({ to: "x@example.com", subject: "Hi", text: "body text", html: "<p>body</p>" }),
    ).resolves.toEqual({}); // nothing was sent, so no provider message id

    expect(spy).toHaveBeenCalledWith(
      // recipient is masked - addresses are personal data and logs don't need them whole
      expect.objectContaining({ to: "x***@example.com", subject: "Hi" }),
      expect.stringMatching(/not configured/i),
    );
    spy.mockRestore();
  });
});
