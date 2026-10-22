import dotenv from "dotenv";
import { z } from "zod";

// Tests set their own environment (test/setup.ts) and must not pick up a
// developer's .env - e.g. an SMTP_HOST pointing at a Mailpit that isn't running.
if (process.env.NODE_ENV !== "test") dotenv.config();

// Validated once at startup - a missing/bad value crashes immediately with a
// readable message rather than failing on the first message consumed.
const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

// RFC 2606 / 6761 reserved TLDs - mail "from" these is rejected or spam-foldered
// by every real mailbox provider.
const RESERVED_TLDS = [".test", ".example", ".invalid", ".localhost", ".local"];

const schema = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().int().positive().default(4100),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    // Postgres - the notifications ledger (prisma/schema.prisma).
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    KAFKA_BROKERS: z.string().min(1, "KAFKA_BROKERS is required"),
    KAFKA_CLIENT_ID: z.string().default("notification-service"),
    KAFKA_GROUP_ID: z.string().default("notification-service"),
    KAFKA_TOPICS: z.string().default("auth.events,hospital.events"),
    // Where messages that can never succeed are parked (see lib/errors.ts).
    KAFKA_DLQ_TOPIC: z.string().min(1).default("notification.dlq"),
    // Managed Kafka (MSK, Confluent Cloud, Aiven...) needs TLS and usually SASL.
    KAFKA_SSL: bool,
    // `KAFKA_SASL_MECHANISM=` in an env file arrives as "" - treat that as unset.
    KAFKA_SASL_MECHANISM: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.enum(["plain", "scram-sha-256", "scram-sha-512"]).optional(),
    ),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),

    // SMTP is optional outside production: with no host the mailer logs instead of sending.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: bool,
    EMAIL_FROM: z.string().default("Uyir <no-reply@uyir.test>"),
  })
  .superRefine((e, ctx) => {
    if (e.KAFKA_SASL_MECHANISM && !(e.KAFKA_SASL_USERNAME && e.KAFKA_SASL_PASSWORD)) {
      ctx.addIssue({
        code: "custom",
        path: ["KAFKA_SASL_USERNAME"],
        message: "KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set",
      });
    }
    // Log mode in production would report every email as handled while sending
    // none - and write password-reset codes into the logs.
    if (e.NODE_ENV === "production" && !e.SMTP_HOST) {
      ctx.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "SMTP_HOST is required in production" });
    }
  });

export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${JSON.stringify(z.treeifyError(parsed.error), null, 2)}`);
  }
  const e = parsed.data;

  // Not fatal: local docker-compose runs in production mode against Mailpit.
  const warnings: string[] = [];
  const fromDomain = (/@([^>\s]+)>?\s*$/.exec(e.EMAIL_FROM)?.[1] ?? "").toLowerCase();
  if (e.NODE_ENV === "production" && RESERVED_TLDS.some((tld) => fromDomain.endsWith(tld))) {
    warnings.push(
      `EMAIL_FROM uses the reserved domain "${fromDomain}" - real mail providers will reject or spam-folder it. ` +
        "Use a domain you own with SPF, DKIM and DMARC set up.",
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    kafka: {
      brokers: csv(e.KAFKA_BROKERS),
      clientId: e.KAFKA_CLIENT_ID,
      groupId: e.KAFKA_GROUP_ID,
      topics: csv(e.KAFKA_TOPICS),
      dlqTopic: e.KAFKA_DLQ_TOPIC,
      ssl: e.KAFKA_SSL,
      sasl:
        e.KAFKA_SASL_MECHANISM && e.KAFKA_SASL_USERNAME && e.KAFKA_SASL_PASSWORD
          ? { mechanism: e.KAFKA_SASL_MECHANISM, username: e.KAFKA_SASL_USERNAME, password: e.KAFKA_SASL_PASSWORD }
          : undefined,
    },
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      secure: e.SMTP_SECURE,
      from: e.EMAIL_FROM,
    },
    warnings,
  };
}

function loadOrExit() {
  try {
    return parseEnv(process.env);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

export const env = loadOrExit();

export const isProduction = env.nodeEnv === "production";
