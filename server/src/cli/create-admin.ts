// Creates (or promotes) an administrator.
//   pnpm --filter @pips/server user:create-admin --email you@pips-ks.org --name "Your Name"
//       → prints a one-time link to set the password (also emailed)
//   pnpm --filter @pips/server user:create-admin --from-env [--name "Your Name"]
//       → takes ADMIN_USER (email) and ADMIN_PASSWORD from .env and sets the password directly.
//         Remove ADMIN_PASSWORD from .env afterwards: only its argon2 hash is stored.
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config.js";
import { hashPassword, issueResetToken, passwordProblem } from "../auth/session.js";
import { INVITE_TTL, resetMail } from "../admin/auth.js";
import { createMailer } from "../lib/mailer.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const fromEnv = process.argv.includes("--from-env");
const email = (fromEnv ? process.env.ADMIN_USER : arg("email"))?.trim().toLowerCase();
const password = fromEnv ? process.env.ADMIN_PASSWORD ?? "" : null;
const name = arg("name")?.trim() || (fromEnv && email ? email.split("@")[0] : undefined);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !name) {
  console.error(fromEnv ? "ADMIN_USER in .env must be an email address." : 'Usage: user:create-admin --email you@example.org --name "Full Name"  |  --from-env');
  process.exit(2);
}
if (password !== null) {
  const problem = passwordProblem(password, { email, username: email });
  if (problem) {
    const why = { tooShort: "is shorter than 12 characters", tooLong: "is longer than 200 characters", containsName: "contains the email name", weak: "is too predictable" }[problem];
    console.error(`ADMIN_PASSWORD ${why}. Choose another one in .env and run this again.`);
    process.exit(2);
  }
}

const config = loadConfig();
const db = new PrismaClient();
const role = await db.role.upsert({ where: { key: "administrator" }, update: {}, create: { key: "administrator", name: "Administrator" } });
const existing = await db.user.findUnique({ where: { email } });

if (password !== null) {
  const passwordHash = await hashPassword(password);
  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { passwordHash, status: "ACTIVE" } })
    : await db.user.create({ data: { email, username: email, displayName: name, passwordHash, status: "ACTIVE" } });
  await db.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: {}, create: { userId: user.id, roleId: role.id } });
  // A new password ends any existing sessions of this account.
  await db.session.deleteMany({ where: { userId: user.id } });
  await db.auditLog.create({ data: { action: "user.create_admin_cli", entityType: "User", entityId: String(user.id), meta: { existing: !!existing, passwordFromEnv: true } } });
  console.log(`${existing ? "Updated" : "Created"} administrator #${user.id} <${user.email}>, active. Sign in at ${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/`);
  console.log("Now remove ADMIN_PASSWORD from .env (only its hash is stored).");
} else {
  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { status: existing.passwordHash ? existing.status === "DISABLED" ? "ACTIVE" : existing.status : "INVITED" } })
    : await db.user.create({ data: { email, username: email, displayName: name, status: "INVITED" } });
  await db.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: {}, create: { userId: user.id, roleId: role.id } });
  await db.auditLog.create({ data: { action: "user.create_admin_cli", entityType: "User", entityId: String(user.id), meta: { existing: !!existing } } });
  const token = await issueResetToken(db, user.id, INVITE_TTL);
  const mail = resetMail(config.PUBLIC_BASE_URL, token, true, user.displayName);
  await createMailer(config).send({ to: user.email, ...mail }).catch(e => console.warn(`Email not sent (${String(e)}); use the link below.`));
  console.log(`${existing ? "Updated" : "Created"} administrator #${user.id} <${user.email}>.`);
  console.log(`Set the password within 7 days: ${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/#/reset?token=${encodeURIComponent(token)}`);
}
await db.$disconnect();
