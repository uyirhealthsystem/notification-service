import { emergencyBookingRequestedData } from "../events/schema";
import { emergencyBookingRequestedEmail } from "../templates/emergencyBookingRequested";
import { emailDelivery } from "../channels/email";
import { deliver, recordSkipped, type EventContext } from "../notifications/deliver";
import { emailProvider } from "../lib/mailer";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

const TEMPLATE = "emergency_booking_requested";

// Handles hospital.events / EmergencyBookingRequested: emails the hospital. Its live dashboard is
// alerted by hospitalservice itself; this is the backup channel. Same retry rules as the other
// handlers - a transient send error is redelivered by Kafka, a bad payload is dead-lettered.
// An SMS / WhatsApp alert to the hospital would be a second deliver() call here.
export async function handleEmergencyBookingRequested(rawData: unknown, ctx: EventContext): Promise<void> {
  const parsed = emergencyBookingRequestedData.safeParse(rawData);
  if (!parsed.success) {
    throw new NonRetryableError("EmergencyBookingRequested: invalid payload", parsed.error.issues);
  }

  const data = parsed.data;
  if (!data.hospitalEmail) {
    logger.warn(
      { bookingId: data.bookingId, hospitalId: data.hospitalId },
      "EmergencyBookingRequested: hospital has no contact email, skipping email",
    );
    await recordSkipped(ctx, {
      channel: "EMAIL",
      template: TEMPLATE,
      referenceId: data.bookingId,
      provider: emailProvider,
      reason: `hospital ${data.hospitalId} has no contact email`,
    });
    return;
  }

  logger.info({ bookingId: data.bookingId, hospitalId: data.hospitalId }, "EmergencyBookingRequested: emailing hospital");
  await deliver(
    ctx,
    emailDelivery(emergencyBookingRequestedEmail(data.hospitalEmail, data), { template: TEMPLATE, referenceId: data.bookingId }),
  );
}
