import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/lib/env";

const base = { KAFKA_BROKERS: "localhost:9092", DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("parseEnv", () => {
  it("refuses to start in production without SMTP_HOST (no silent log mode)", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(/SMTP_HOST is required in production/);
  });

  it("allows log mode outside production", () => {
    expect(parseEnv({ ...base, NODE_ENV: "development" }).smtp.host).toBeUndefined();
  });

  it("warns (but starts) in production with a reserved EMAIL_FROM domain", () => {
    const env = parseEnv({ ...base, NODE_ENV: "production", SMTP_HOST: "mailpit" });
    expect(env.warnings).toEqual([expect.stringMatching(/reserved domain "uyir.test"/)]);
  });

  it("has no warnings with a real sender domain", () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: "production",
      SMTP_HOST: "email-smtp.ap-south-1.amazonaws.com",
      EMAIL_FROM: "Uyir <no-reply@uyirhealthapp.com>",
    });
    expect(env.warnings).toEqual([]);
  });

  it("builds Kafka TLS + SASL config", () => {
    const env = parseEnv({
      ...base,
      KAFKA_SSL: "true",
      KAFKA_SASL_MECHANISM: "scram-sha-512",
      KAFKA_SASL_USERNAME: "u",
      KAFKA_SASL_PASSWORD: "p",
    });
    expect(env.kafka.ssl).toBe(true);
    expect(env.kafka.sasl).toEqual({ mechanism: "scram-sha-512", username: "u", password: "p" });
  });

  it("treats empty SASL settings (as copied from .env.example) as no SASL", () => {
    const env = parseEnv({ ...base, KAFKA_SASL_MECHANISM: "", KAFKA_SASL_USERNAME: "", KAFKA_SASL_PASSWORD: "" });
    expect(env.kafka.sasl).toBeUndefined();
  });

  it("rejects a SASL mechanism without credentials", () => {
    expect(() => parseEnv({ ...base, KAFKA_SASL_MECHANISM: "plain" })).toThrow(/KAFKA_SASL_USERNAME/);
  });
});
