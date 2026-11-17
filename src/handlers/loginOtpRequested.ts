import { loginOtpRequestedData } from "../events/schema";
import { loginOtpEmail } from "../templates/loginOtp";
import { emailDelivery } from "../channels/email";
import { deliver, recordSkipped, type EventContext } from "../notifications/deliver";
import { emailProvider } from "../lib/mailer";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

const TEMPLATE = "login_otp";

// Handles auth.events / LoginOtpRequested: emails the sign-in code for the
// second step of email/password login. Bad payload -> NonRetryableError
// (dead-lettered, with the otp redacted by the consumer); SMTP down -> thrown,
// redelivered by kafkajs.
export async function handleLoginOtpRequested(rawData: unknown, ctx: EventContext): Promise<void> {
  const parsed = loginOtpRequestedData.safeParse(rawData);
  if (!parsed.success) {
    throw new NonRetryableError("LoginOtpRequested: invalid payload", parsed.error.issues);
  }

  const data = parsed.data;
  // A redelivered or long-queued event can outlive its code (5 min). The user
  // can't use it any more - don't send a code that won't work.
  if (new Date(data.expiresAt).getTime() <= Date.now()) {
    logger.info({ userId: data.userId, expiresAt: data.expiresAt }, "LoginOtpRequested: code already expired, not sending");
    await recordSkipped(ctx, {
      channel: "EMAIL",
      template: TEMPLATE,
      recipient: data.email,
      referenceId: data.userId,
      provider: emailProvider,
      reason: `code expired at ${data.expiresAt}`,
    });
    return;
  }

  logger.info({ userId: data.userId }, "LoginOtpRequested: sending sign-in code");
  await deliver(ctx, emailDelivery(loginOtpEmail(data), { template: TEMPLATE, referenceId: data.userId }));
}
