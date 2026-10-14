import { defineConfig, devices } from "@playwright/test";

const PORT = 5180 + Number(process.env["ZOLANA_PORT_OFFSET"] ?? 0);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Needs the escrow localnet running: `just test-escrow-web` starts it.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env["CI"],
  timeout: 10 * 60_000,
  expect: { timeout: 120_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --config vite.config.ts",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
