import { defineConfig, devices } from "@playwright/test";

// Runs against a running server (pnpm dev): BASE_URL=http://localhost:8080 by default. Read-only: no form is submitted.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:8080", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /public\.spec/ },
  ],
});
