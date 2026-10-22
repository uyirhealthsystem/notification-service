import { defineConfig } from "vitest/config";

// No external dependencies in these tests - the mailer is mocked and Kafka is
// never contacted. They exercise the handler + template + log-mode mailer.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
