import { passwordResetRequestedData } from "../events/schema";
import { passwordResetEmail } from "../templates/passwordReset";
import { emailDelivery } from "../channels/email";
import { deliver, recordSkipped, type EventContext } from "../notifications/deliver";
import { emailProvider } from "../lib/mailer";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

const TEMPLATE = "password_reset";

// Handles auth.events / PasswordResetRequested. A thrown error here propagates
// to the consumer: NonRetryableError (bad payload, mailbox rejected) is
// dead-lettered, anything else is redelivered by kafkajs later (SMTP was down).
export async function handlePasswordResetRequested(rawData: unknown, ctx: EventContext): Promise<void> {
  const parsed = passwordResetRequestedData.safeParse(rawData);
  if (!parsed.success) {
    throw new NonRetryableError("PasswordResetRequested: invalid payload", parsed.error.issues);
  }

  const { email, otp, expiresAt, userId } = parsed.data;
  // A redelivered or long-queued event can outlive its code. authservice would
  // reject it anyway; don't send the user a code that can't work.
  if (new Date(expiresAt).getTime() <= Date.now()) {
    logger.info({ userId, expiresAt }, "PasswordResetRequested: code already expired, not sending");
    await recordSkipped(ctx, {
      channel: "EMAIL",
      template: TEMPLATE,
      recipient: email,
      referenceId: userId,
      provider: emailProvider,
      reason: `code expired at ${expiresAt}`,
    });
    return;
  }

  logger.info({ userId }, "PasswordResetRequested: sending reset email");
  await deliver(ctx, emailDelivery(passwordResetEmail(email, otp, expiresAt), { template: TEMPLATE, referenceId: userId }));
}
