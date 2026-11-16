import { defineConfig } from "vitest/config";

// Permission matrix: boots the API against the throwaway pips_test database (see src/cli/test-db.ts).
export default defineConfig({ test: { include: ["src/**/*.matrix.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false } });
