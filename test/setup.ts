// Runs before the module graph is imported, so src/lib/env.ts sees these.
// NODE_ENV=test also stops env.ts from loading the developer's .env, so a local
// SMTP_HOST (e.g. Mailpit) can't leak into the tests.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
process.env.KAFKA_BROKERS ??= "localhost:9092"; // never actually connected in tests
// Postgres: unit tests mock the client and never connect. test/deliver.db.test.ts
// runs against a real database only when TEST_DATABASE_URL is set (CI does).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
// SMTP intentionally left unset -> the mailer runs in log mode.
