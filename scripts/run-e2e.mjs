import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const env = {
  ...process.env,
  LUBAN_AUTH_MODE: "demo",
  LUBAN_DATABASE_PROVIDER: "sqlite",
  LUBAN_DATABASE_PATH: join(process.cwd(), "data", "luban.e2e.sqlite"),
  LUBAN_DEMO_MODE: "true",
  LUBAN_MARKET_DATA_PROVIDER: "synthetic",
  VERCEL: "0",
  VERCEL_ENV: "development",
};

// Invoke the installed binaries directly: no shell, inherited database mode,
// or build lifecycle hook that could run a production migration.
for (const [module, args] of [
  ["next/dist/bin/next", ["build"]],
  ["@playwright/test/cli", ["test", ...process.argv.slice(2)]],
]) {
  const result = spawnSync(process.execPath, [require.resolve(module), ...args], {
    env, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
