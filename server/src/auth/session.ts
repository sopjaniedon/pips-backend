// Password hashing and server-side sessions. The cookie holds an opaque random token; the database stores only
// its SHA-256, so a database leak does not expose live sessions. Each session has its own CSRF token.
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import { permissionsFor, type Permission } from "./permissions.js";

export const COOKIE = "pips_sid";
export const IDLE_MS = 12 * 3600_000; // signed out after 12 hours without activity
export const ABSOLUTE_MS = 7 * 24 * 3600_000; // and after 7 days in any case
export const MIN_PASSWORD = 12;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = sha;

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
let dummy: Promise<string> | null = null;
/** Always runs one argon2 verification, so unknown accounts take as long as wrong passwords. */
export async function verifyPassword(hash: string | null | undefined, pw: string): Promise<boolean> {
  const h = hash ?? (await (dummy ??= hashPassword(newToken())));
  try { return (await argon2.verify(h, pw)) && !!hash; } catch { return false; }
}

export function passwordProblem(pw: string, user?: { email: string; username: string }): string | null {
  if (pw.length < MIN_PASSWORD) return "tooShort";
  if (pw.length > 200) return "tooLong";
  const low = pw.toLowerCase();
  if (user && (low.includes(user.username.toLowerCase()) || low.includes(user.email.split("@")[0].toLowerCase()))) return "containsName";
  if (/^(.)\1+$/.test(pw)) return "weak";
  return null;
}

export async function createSession(db: PrismaClient, userId: number, meta: { ip?: string; userAgent?: string }) {
  const token = newToken(), csrf = newToken();
  const now = Date.now();
  await db.session.create({ data: { id: sha(token), userId, csrfToken: csrf, expiresAt: new Date(now + ABSOLUTE_MS), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) } });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(now) } });
  return { token, csrf };
}

export interface SessionUser {
  id: number; username: string; email: string; displayName: string; roles: string[]; isSuperUser: boolean;
}
export interface LoadedSession { id: string; csrf: string; user: SessionUser; perms: Set<Permission> }

export async function loadSession(db: PrismaClient, token: string | undefined): Promise<LoadedSession | null> {
  if (!token) return null;
  const s = await db.session.findUnique({ where: { id: sha(token) }, include: { user: { include: { roles: { include: { role: true } } } } } });
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt.getTime() < now || s.lastSeenAt.getTime() + IDLE_MS < now || s.user.status !== "ACTIVE") {
    await db.session.delete({ where: { id: s.id } }).catch(() => undefined);
    return null;
  }
  if (now - s.lastSeenAt.getTime() > 5 * 60_000) await db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  const roles = s.user.roles.map(r => r.role.key);
  return {
    id: s.id, csrf: s.csrfToken,
    user: { id: s.user.id, username: s.user.username, email: s.user.email, displayName: s.user.displayName, roles, isSuperUser: s.user.isSuperUser },
    perms: permissionsFor(roles, s.user.isSuperUser),
  };
}

export async function issueResetToken(db: PrismaClient, userId: number, ttlMs: number) {
  const token = newToken();
  await db.passwordResetToken.create({ data: { userId, tokenHash: sha(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}
