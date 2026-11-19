import type { Email } from "../lib/mailer";
import type { HospitalClaimCodeIssuedData } from "../events/schema";
import { escapeHtml } from "../lib/html";

// "2026-11-26T10:00:00Z" -> "26 Nov 2026" (IST calendar day).
function readableDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

// Sent to the hospital's contact email after a PRO onboards it (and again on every resend). The hospital
// admin signs up / logs in to the Uyir Service Provider app as a Hospital and enters both values to link
// the account to the hospital.
export function hospitalClaimCodeIssuedEmail(data: HospitalClaimCodeIssuedData): Email {
  const hospital = data.hospitalName ?? "your hospital";
  const until = readableDate(data.expiresAt);
  const resend = data.reason === "RESEND";

  const lead = resend
    ? `Here is a new claim code for ${hospital}. Any earlier code no longer works.`
    : `${hospital} has been registered on Uyir by our field officer. Link it to your account to start managing it.`;

  const text = [
    "Hello,",
    "",
    lead,
    "",
    `Hospital ID: ${data.hospitalId}`,
    `Claim code:  ${data.claimCode}   (valid until ${until}, single use)`,
    "",
    "How to link your hospital:",
    "1. Open the Uyir Service Provider app and register (or log in) as a Hospital.",
    "2. When asked to link your hospital, enter the Hospital ID and claim code above.",
    "",
    "Keep this code private - anyone with it can take control of the hospital's account.",
    "Code expired or lost? Ask your Uyir field officer to send a new one.",
  ].join("\n");

  const html = `
    <p>Hello,</p>
    <p>${escapeHtml(lead)}</p>
    <table style="border-collapse:collapse; margin:16px 0">
      <tr>
        <td style="padding:6px 12px 6px 0; color:#666">Hospital ID</td>
        <td style="padding:6px 0; font-family:monospace; font-size:1.05em">${escapeHtml(data.hospitalId)}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px 6px 0; color:#666">Claim code</td>
        <td style="padding:6px 0; font-size:1.6em; font-weight:bold; letter-spacing:0.15em">${escapeHtml(data.claimCode)}</td>
      </tr>
    </table>
    <p style="color:#666">Valid until <strong>${escapeHtml(until)}</strong>. It works once.</p>
    <p><strong>How to link your hospital</strong></p>
    <ol>
      <li>Open the Uyir Service Provider app and register (or log in) as a <strong>Hospital</strong>.</li>
      <li>When asked to link your hospital, enter the Hospital ID and claim code above.</li>
    </ol>
    <p style="color:#666">Keep this code private - anyone with it can take control of the hospital's account.
    Code expired or lost? Ask your Uyir field officer to send a new one.</p>
  `.trim();

  const subject = resend
    ? `New claim code for ${hospital} on Uyir`
    : `Link ${hospital} to your Uyir account`;

  return { to: data.email, subject, text, html };
}
