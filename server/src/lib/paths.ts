import { resolve } from "node:path";
import type { Config } from "../config.js";

// Relative paths in .env are relative to the repository root (the server runs from server/ in development).
export function paths(config: Config) {
  const repoRoot = process.cwd().endsWith("/server") ? resolve(process.cwd(), "..") : process.cwd();
  return { repoRoot, webDir: resolve(repoRoot, config.WEB_DIR), storageDir: resolve(repoRoot, config.STORAGE_DIR) };
}
