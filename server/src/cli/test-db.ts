// Recreates the throwaway test database (pips_test) next to the dev database and applies all migrations.
// Only ever touches a database whose name ends in "_test".
import { execFileSync } from "node:child_process";
import pg from "@prisma/client";

export function testUrl(url = process.env.DATABASE_URL ?? ""): string {
  const u = new URL(url);
  u.pathname = "/pips_test";
  return u.toString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = testUrl();
  const name = new URL(target).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error("refusing to recreate a database not named *_test");
  const admin = new pg.PrismaClient();
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await admin.$disconnect();
  execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: target }, stdio: "inherit" });
  console.log(`test database ${name} ready`);
}
