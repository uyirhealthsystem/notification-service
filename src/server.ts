import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { startConsumer, stopConsumer } from "./kafka/consumer";
import { closeMailer } from "./lib/mailer";
import { prisma } from "./lib/prisma";

for (const warning of env.warnings) logger.warn(warning);

const server = app.listen(env.port, () => {
  logger.info(`notification-service listening on port ${env.port} (${env.nodeEnv})`);
});

// Postgres first: every send is recorded, so consuming without it would just
// fail on the first event.
prisma
  .$connect()
  .catch((err) => {
    logger.fatal({ err }, "could not connect to Postgres (DATABASE_URL) - exiting");
    process.exit(1);
  })
  .then(() => startConsumer())
  .catch((err) => {
    logger.fatal({ err }, "kafka consumer failed to start - exiting");
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown initiated");
  server.close(async () => {
    await stopConsumer();
    await closeMailer();
    await prisma.$disconnect().catch((err) => logger.error({ err }, "error disconnecting from Postgres"));
    logger.info("shutdown complete");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandledRejection"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException - exiting");
  process.exit(1);
});
