import nodemailer, { Transporter } from "nodemailer";
import { env } from "./env";
import { logger } from "./logger";
import { NonRetryableError } from "./errors";
import { maskEmail } from "./html";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Two modes:
//   SMTP_HOST set   -> a real pooled SMTP transport with short timeouts
//   SMTP_HOST unset -> "log mode": render and log the email, never send
// Log mode keeps local dev and CI working with no mail server. env.ts refuses
// to start in production without SMTP_HOST, so it never happens there.
const smtpConfigured = Boolean(env.smtp.host);

// Recorded on each notification row - "log" rows were never actually sent.
export const emailProvider = smtpConfigured ? "smtp" : "log";

let transporter: Transporter | undefined;
function getTransport(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
      pool: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}

// A 5xx reply to the envelope (MAIL FROM / RCPT TO) or the message itself is
// about THIS email - "no such mailbox", "message rejected" - and will fail the
// same way on every retry. 5xx elsewhere (EAUTH: bad credentials) and every
// network error are about the server or our config, which affects all mail
// alike; those stay retryable so nothing is lost while it gets fixed.
function isPermanent(err: unknown): boolean {
  const { code, responseCode } = (err ?? {}) as { code?: string; responseCode?: number };
  return (
    (code === "EENVELOPE" || code === "EMESSAGE") &&
    typeof responseCode === "number" &&
    responseCode >= 500 &&
    responseCode < 600
  );
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sends with a few retries on transient failure and returns the SMTP Message-ID.
// Throws NonRetryableError on a permanent rejection (the consumer dead-letters
// it), or the last error once every attempt fails (the consumer lets kafkajs
// redeliver it later).
export async function sendEmail(email: Email): Promise<{ messageId?: string }> {
  const to = maskEmail(email.to);
  if (!smtpConfigured) {
    logger.info({ to, subject: email.subject, body: email.text }, "SMTP not configured - email logged, not sent");
    return {};
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const info = await getTransport().sendMail({
        from: env.smtp.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      logger.info({ to, subject: email.subject, attempt, messageId: info.messageId }, "email sent");
      return { messageId: info.messageId };
    } catch (err) {
      if (isPermanent(err)) {
        const { responseCode, response } = err as { responseCode?: number; response?: string };
        throw new NonRetryableError(`SMTP rejected the email permanently (${responseCode})`, {
          to,
          subject: email.subject,
          response,
        });
      }
      lastErr = err;
      logger.warn({ err, to, attempt }, "email send attempt failed");
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

export async function closeMailer(): Promise<void> {
  transporter?.close();
  transporter = undefined;
}
