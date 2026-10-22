import express from "express";
import { getConsumerState } from "./kafka/status";

// Tiny HTTP surface - just a health probe. All real work happens in the Kafka
// consumer, not over HTTP, so health means "the consumer is running", not just
// "this server answers".
export const app = express();

app.get("/health", (_req, res) => {
  const consumer = getConsumerState();
  const ok = consumer === "running";
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", service: "notification-service", consumer });
});
