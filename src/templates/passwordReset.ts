import type { Email } from "../lib/mailer";
import { escapeHtml } from "../lib/html";

function minutesUntil(iso: string): number {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return mins > 0 ? mins : 0;
}

export function passwordResetEmail(to: string, otp: string, expiresAt: string): Email {
  const mins = minutesUntil(expiresAt);
  const window = mins > 0 ? `in about ${mins} minute${mins === 1 ? "" : "s"}` : "shortly";

  const text = [
    "We received a request to set or reset the password for your Uyir account.",
    "",
    `Your code is: ${otp}`,
    `Enter it in the app to choose a new password. It expires ${window}.`,
    "",
    "If you didn't ask for this, you can ignore this email - your account is unchanged.",
  ].join("\n");

  const html = `
    <p>We received a request to set or reset the password for your Uyir account.</p>
    <p>
      Your code is: <strong style="font-size:1.25em; letter-spacing:0.15em">${escapeHtml(otp)}</strong><br />
      <small>Enter it in the app to choose a new password. This code expires ${window}.</small>
    </p>
    <p style="color:#666">If you didn't ask for this, you can ignore this email - your account is unchanged.</p>
  `.trim();

  return { to, subject: "Your Uyir password reset code", text, html };
}
