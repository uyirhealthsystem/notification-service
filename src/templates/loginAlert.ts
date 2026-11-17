import type { Email } from "../lib/mailer";
import type { UserLoggedInData } from "../events/schema";
import { escapeHtml } from "../lib/html";

// "2026-11-17T09:30:00.000Z" -> "17 Nov 2026, 3:00 pm IST"
function readableTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatted} IST`;
}

export function loginAlertEmail(data: UserLoggedInData): Email {
  const when = readableTime(data.loggedInAt);
  const method = data.method === "GOOGLE" ? "Google" : "Email and password";
  const details: [string, string][] = [
    ["Time", when],
    ["Signed in with", method],
    ["App", data.portalName],
    ...(data.userAgent ? ([["Device", data.userAgent]] as [string, string][]) : []),
    ...(data.ip ? ([["IP address", data.ip]] as [string, string][]) : []),
  ];

  const text = [
    "There was a new sign-in to your Uyir account.",
    "",
    ...details.map(([k, v]) => `${k}: ${v}`),
    "",
    "If this was you, you don't need to do anything.",
    "If it wasn't you, reset your password right away using \"Forgot password\" in the app.",
  ].join("\n");

  const rows = details
    .map(([k, v]) => `<tr><td style="color:#666; padding-right:12px">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  const html = `
    <p>There was a new sign-in to your Uyir account.</p>
    <table>${rows}</table>
    <p>If this was you, you don't need to do anything.</p>
    <p><strong>If it wasn't you</strong>, reset your password right away using "Forgot password" in the app.</p>
  `.trim();

  return { to: data.email, subject: "New sign-in to your Uyir account", text, html };
}
