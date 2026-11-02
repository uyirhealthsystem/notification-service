import type { Email } from "../lib/mailer";
import type { FollowUpReminderDueData } from "../events/schema";
import { escapeHtml } from "../lib/html";

// "2026-11-12" -> "12 Nov 2026". The date is already an IST calendar day, so format it as UTC to avoid shifting it.
function readableDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

export function followUpReminderDueEmail(to: string, data: FollowUpReminderDueData): Email {
  const due = readableDate(data.dueDate);
  const from = readableDate(data.bookableFrom);
  const until = readableDate(data.bookableUntil);
  const hospital = data.hospitalName ?? "the hospital";
  const doctor = data.doctorName ?? "your doctor";
  const dueToday = data.reminderType === "DUE_TODAY";

  const lead = dueToday
    ? `Your follow-up visit with ${doctor} at ${hospital} is due today (${due}).`
    : `Your follow-up visit with ${doctor} at ${hospital} is due on ${due}.`;

  const text = [
    `Hello ${data.patientName},`,
    "",
    lead,
    ...(data.instructions ? ["", `Doctor's instructions: ${data.instructions}`] : []),
    "",
    `You can book it in the Uyir app for any date from ${from} to ${until}.`,
    ...(data.hospitalPhone ? [`Questions? Call ${hospital} on ${data.hospitalPhone}.`] : []),
    "",
    `Appointment reference: ${data.appointmentId}`,
  ].join("\n");

  const html = `
    <p>Hello ${escapeHtml(data.patientName)},</p>
    <p>${escapeHtml(lead)}</p>
    ${data.instructions ? `<p><strong>Doctor's instructions:</strong> ${escapeHtml(data.instructions)}</p>` : ""}
    <p>You can book it in the Uyir app for any date from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(until)}</strong>.</p>
    ${data.hospitalPhone
      ? `<p>Questions? Call ${escapeHtml(hospital)} on <a href="tel:${escapeHtml(data.hospitalPhone)}">${escapeHtml(data.hospitalPhone)}</a>.</p>`
      : ""}
    <p style="color:#666">Appointment reference: ${escapeHtml(data.appointmentId)}</p>
  `.trim();

  const subject = dueToday
    ? `Your follow-up with ${doctor} is due today - book now`
    : `Reminder: follow-up with ${doctor} due on ${due}`;

  return { to, subject, text, html };
}
