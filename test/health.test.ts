import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../src/app";
import { setConsumerState } from "../src/kafka/status";

let server: Server;
let url: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("GET /health", () => {
  it("is 200 only while the Kafka consumer is running", async () => {
    setConsumerState("running");
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", consumer: "running" });
  });

  it.each(["starting", "restarting", "stopped"] as const)("is 503 while the consumer is %s", async (state) => {
    setConsumerState(state);
    const res = await fetch(url);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", consumer: state });
  });
});
