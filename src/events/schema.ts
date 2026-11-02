import { z } from "zod";

// Contract with the producers. The envelope is common to every domain event;
// `data` is validated per eventType by the handler that claims it.
export const envelopeSchema = z.object({
  // Optional, not sent by any producer yet. When present it is the idempotency
  // key for notifications (stable even if the same event is published twice);
  // without it, the Kafka topic/partition/offset is.
  eventId: z.string().min(1).optional(),
  eventType: z.string(),
  eventVersion: z.number(),
  occurredAt: z.string(),
  data: z.unknown(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

// authservice -> "auth.events" -> PasswordResetRequested (v1)
export const passwordResetRequestedData = z.object({
  userId: z.string(),
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, "otp must be 6 digits"),
  expiresAt: z.iso.datetime(),
});
export type PasswordResetRequestedData = z.infer<typeof passwordResetRequestedData>;

// hospitalservice -> "hospital.events" -> EmergencyBookingRequested (v1)
// hospitalName / hospitalEmail are null when the hospital never filled them in.
export const emergencyBookingRequestedData = z.object({
  bookingId: z.string(),
  hospitalId: z.string(),
  hospitalName: z.string().nullish(),
  hospitalEmail: z.string().email().nullish(),
  patientName: z.string(),
  patientPhone: z.string(),
  emergencyType: z.string(),
  requestedAt: z.string(),
});
export type EmergencyBookingRequestedData = z.infer<typeof emergencyBookingRequestedData>;

// hospitalservice -> "hospital.events" -> FollowUpReminderDue (v1)
// The hospital asked the patient to come back; this reminds them to book it. Dates are yyyy-MM-dd (IST);
// the follow-up can be booked for any date in [bookableFrom, bookableUntil]. Names/phone/instructions
// are null when not recorded.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-MM-dd");
export const followUpReminderDueData = z.object({
  appointmentId: z.string(),
  reminderType: z.enum(["UPCOMING", "DUE_TODAY"]),
  patientId: z.string(),
  patientName: z.string(),
  patientEmail: z.string().email(),
  hospitalId: z.string(),
  hospitalName: z.string().nullish(),
  hospitalPhone: z.string().nullish(),
  doctorId: z.string(),
  doctorName: z.string().nullish(),
  dueDate: isoDate,
  bookableFrom: isoDate,
  bookableUntil: isoDate,
  instructions: z.string().nullish(),
});
export type FollowUpReminderDueData = z.infer<typeof followUpReminderDueData>;
