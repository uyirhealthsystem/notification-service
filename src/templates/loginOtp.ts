import type { Email } from "../lib/mailer";
import type { LoginOtpRequestedData } from "../events/schema";
import { escapeHtml } from "../lib/html";

function minutesUntil(iso: string): number {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  return mins > 0 ? mins : 0;
}

export function loginOtpEmail(data: LoginOtpRequestedData): Email {
  const mins = minutesUntil(data.expiresAt);
  const window = mins > 0 ? `in ${mins} minute${mins === 1 ? "" : "s"}` : "shortly";
  const where = [data.portalName, data.userAgent].filter(Boolean).join(" - ");

  const text = [
    `Your Uyir sign-in code is: ${data.otp}`,
    "",
    `Enter it to finish signing in to ${data.portalName}. It expires ${window}.`,
    ...(where ? ["", `Requested from: ${where}${data.ip ? ` (IP ${data.ip})` : ""}`] : []),
    "",
    "Never share this code with anyone - Uyir staff will never ask for it.",
    "If you didn't try to sign in, someone may know your password. Reset it now using \"Forgot password\" in the app.",
  ].join("\n");

  const html = `
    <p>Your Uyir sign-in code is:</p>
    <p style="font-size:1.6em; font-weight:bold; letter-spacing:0.2em">${escapeHtml(data.otp)}</p>
    <p>Enter it to finish signing in to ${escapeHtml(data.portalName)}. It expires ${window}.</p>
    ${where ? `<p style="color:#666"><small>Requested from: ${escapeHtml(where)}${data.ip ? ` (IP ${escapeHtml(data.ip)})` : ""}</small></p>` : ""}
    <p style="color:#666">Never share this code with anyone - Uyir staff will never ask for it.</p>
    <p><strong>If you didn't try to sign in</strong>, someone may know your password. Reset it now using "Forgot password" in the app.</p>
  `.trim();

  // Code in the subject so it shows in the phone's notification preview.
  return { to: data.email, subject: `${data.otp} is your Uyir sign-in code`, text, html };
}
