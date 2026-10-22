import type { Email } from "../lib/mailer";
import type { EmergencyBookingRequestedData } from "../events/schema";
import { escapeHtml } from "../lib/html";

// Hospitals are in India; show the time the way their staff read a clock.
function istTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
}

export function emergencyBookingRequestedEmail(to: string, data: EmergencyBookingRequestedData): Email {
  const when = istTime(data.requestedAt);
  const hospital = data.hospitalName ?? "your hospital";

  const text = [
    `A new emergency booking has been made at ${hospital}.`,
    "",
    `Emergency:  ${data.emergencyType}`,
    `Patient:    ${data.patientName}`,
    `Phone:      ${data.patientPhone}`,
    `Requested:  ${when}`,
    `Booking ID: ${data.bookingId}`,
    "",
    "Open your Uyir hospital dashboard to accept or reject it. The patient is waiting for your answer.",
  ].join("\n");

  const html = `
    <p><strong style="color:#b00020">New emergency booking</strong> at ${escapeHtml(hospital)}.</p>
    <table cellpadding="4" style="border-collapse:collapse">
      <tr><td style="color:#666">Emergency</td><td><strong>${escapeHtml(data.emergencyType)}</strong></td></tr>
      <tr><td style="color:#666">Patient</td><td>${escapeHtml(data.patientName)}</td></tr>
      <tr><td style="color:#666">Phone</td><td><a href="tel:${escapeHtml(data.patientPhone)}">${escapeHtml(data.patientPhone)}</a></td></tr>
      <tr><td style="color:#666">Requested</td><td>${escapeHtml(when)}</td></tr>
      <tr><td style="color:#666">Booking ID</td><td>${escapeHtml(data.bookingId)}</td></tr>
    </table>
    <p>Open your Uyir hospital dashboard to accept or reject it. The patient is waiting for your answer.</p>
  `.trim();

  return { to, subject: `EMERGENCY: ${data.emergencyType} - new booking (${data.patientName})`, text, html };
}
