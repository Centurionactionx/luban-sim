import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3010";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: "pnpm start --hostname 127.0.0.1 --port 3010",
        url: baseURL,
        env: {
          LUBAN_AUTH_MODE: "demo",
          LUBAN_DEMO_MODE: "true",
          LUBAN_MARKET_DATA_PROVIDER: "synthetic",
        },
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
