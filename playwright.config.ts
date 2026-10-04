import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3010";
const testUrl = new URL(baseURL);
if (testUrl.origin !== "http://127.0.0.1:3010" || process.env.PLAYWRIGHT_SKIP_WEBSERVER) {
  throw new Error("Destructive simulator tests require their own local server at http://127.0.0.1:3010.");
}

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
  webServer: {
    command: "pnpm start --hostname 127.0.0.1 --port 3010",
    url: baseURL,
    env: {
      LUBAN_AUTH_MODE: "demo",
      LUBAN_DATABASE_PROVIDER: "sqlite",
      LUBAN_DATABASE_PATH: join(process.cwd(), "data", "luban.e2e.sqlite"),
      LUBAN_DEMO_MODE: "true",
      LUBAN_MARKET_DATA_PROVIDER: "synthetic",
      LUBAN_ENABLE_WORKING_ORDERS: "true",
      // Lets tests run the price checker on demand. Test-only value.
      CRON_SECRET: "e2e-local-cron-secret",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
