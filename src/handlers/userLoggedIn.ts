import { userLoggedInData } from "../events/schema";
import { loginAlertEmail } from "../templates/loginAlert";
import { emailDelivery } from "../channels/email";
import { deliver, type EventContext } from "../notifications/deliver";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

const TEMPLATE = "login_alert";

// Handles auth.events / UserLoggedIn: emails the user a "new sign-in" alert.
// Bad payload -> NonRetryableError (dead-lettered); SMTP down -> thrown, redelivered.
export async function handleUserLoggedIn(rawData: unknown, ctx: EventContext): Promise<void> {
  const parsed = userLoggedInData.safeParse(rawData);
  if (!parsed.success) {
    throw new NonRetryableError("UserLoggedIn: invalid payload", parsed.error.issues);
  }

  const data = parsed.data;
  logger.info({ userId: data.userId, portalId: data.portalId, method: data.method }, "UserLoggedIn: sending login alert");
  await deliver(ctx, emailDelivery(loginAlertEmail(data), { template: TEMPLATE, referenceId: data.userId }));
}
