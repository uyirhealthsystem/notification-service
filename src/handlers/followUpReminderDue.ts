import { followUpReminderDueData } from "../events/schema";
import { followUpReminderDueEmail } from "../templates/followUpReminderDue";
import { emailDelivery } from "../channels/email";
import { deliver, type EventContext } from "../notifications/deliver";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

const TEMPLATE = "follow_up_reminder";

// Handles hospital.events / FollowUpReminderDue: emails the patient a reminder to book the follow-up the
// hospital asked for. hospitalservice only publishes it when the booking has a patientEmail and the
// follow-up isn't booked yet, and sends each reminder (UPCOMING, DUE_TODAY) once.
export async function handleFollowUpReminderDue(rawData: unknown, ctx: EventContext): Promise<void> {
  const parsed = followUpReminderDueData.safeParse(rawData);
  if (!parsed.success) {
    throw new NonRetryableError("FollowUpReminderDue: invalid payload", parsed.error.issues);
  }

  const data = parsed.data;
  logger.info(
    { appointmentId: data.appointmentId, reminderType: data.reminderType },
    "FollowUpReminderDue: emailing patient",
  );
  await deliver(
    ctx,
    emailDelivery(followUpReminderDueEmail(data.patientEmail, data), {
      template: TEMPLATE,
      referenceId: `${data.appointmentId}:${data.reminderType}`,
    }),
  );
}
