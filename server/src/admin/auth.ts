// Sign-in, sign-out, password reset and the admin bootstrap (who am I, what may I do, lookups).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COOKIE, ABSOLUTE_MS, createSession, hashPassword, issueResetToken, passwordProblem, tokenHash, verifyPassword } from "../auth/session.js";
import { FLAGS } from "../auth/permissions.js";
import type { Mailer } from "../lib/mailer.js";
import { audit, routes } from "./registry.js";

const RESET_TTL = 60 * 60_000; // 1 hour
export const INVITE_TTL = 7 * 24 * 3600_000; // 7 days

export function resetMail(baseUrl: string, token: string, invite: boolean, name: string) {
  const link = `${baseUrl.replace(/\/$/, "")}/admin/#/reset?token=${encodeURIComponent(token)}`;
  return {
    subject: invite ? "PIPS: krijoni fjalëkalimin tuaj / set your password" : "PIPS: rivendosja e fjalëkalimit / password reset",
    html: `<p>${invite ? "Përshëndetje" : "Përshëndetje"} ${name.replace(/[<>&]/g, "")},</p>
<p>${invite ? "Llogaria juaj në panelin e PIPS është gati. Krijoni fjalëkalimin këtu:" : "Për të vendosur një fjalëkalim të ri, hapni këtë lidhje:"}</p>
<p><a href="${link}">${link}</a></p>
<p>${invite ? "Lidhja vlen 7 ditë." : "Lidhja vlen 1 orë. Nëse nuk e keni kërkuar, injorojeni këtë email."}</p>
<hr><p style="color:#666">${invite ? "Your PIPS admin account is ready. Set your password with the link above (valid 7 days)." : "Use the link above to set a new password (valid 1 hour). If you did not ask for it, ignore this email."}</p>`,
  };
}

export async function authRoutes(app: FastifyInstance, mailer: Mailer) {
  const { db, config } = app;
  const r = routes(app, "/api/admin");
  const secure = config.NODE_ENV === "production";
  const cookieOpts = { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: ABSOLUTE_MS / 1000 };
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } };

  const Login = z.object({ login: z.string().min(1).max(254), password: z.string().min(1).max(200) });
  r.post("/auth/login", "public", async (req, reply) => {
    const b = Login.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const login = b.data.login.trim().toLowerCase();
    const user = await db.user.findFirst({ where: { OR: [{ email: login }, { username: { equals: login, mode: "insensitive" } }] } });
    const ok = await verifyPassword(user?.passwordHash, b.data.password);
    if (!user || !ok || user.status !== "ACTIVE") {
      if (user) await db.auditLog.create({ data: { actorId: user.id, action: "auth.login_failed", entityType: "User", entityId: String(user.id), ip: req.ip } });
      return reply.code(401).send({ error: "badCredentials" });
    }
    const s = await createSession(db, user.id, { ip: req.ip, userAgent: req.headers["user-agent"] });
    reply.setCookie(COOKIE, s.token, cookieOpts);
    await db.auditLog.create({ data: { actorId: user.id, action: "auth.login", entityType: "User", entityId: String(user.id), ip: req.ip, userAgent: req.headers["user-agent"]?.slice(0, 300) } });
    return { ok: true, csrf: s.csrf };
  }, loginLimit);

  r.post("/auth/logout", "auth", async (req, reply) => {
    await db.session.delete({ where: { id: req.admin!.id } }).catch(() => undefined);
    reply.clearCookie(COOKIE, { path: "/" });
    await audit(req, "auth.logout", "User", req.admin!.user.id);
    return { ok: true };
  });

  const Forgot = z.object({ email: z.string().email().max(254) });
  r.post("/auth/forgot", "public", async (req, reply) => {
    const b = Forgot.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const user = await db.user.findUnique({ where: { email: b.data.email.toLowerCase() } });
    // Same answer whether or not the account exists.
    if (user && user.status !== "DISABLED") {
      const token = await issueResetToken(db, user.id, RESET_TTL);
      const m = resetMail(config.PUBLIC_BASE_URL, token, user.status === "INVITED", user.displayName);
      mailer.send({ to: user.email, ...m }).catch(e => req.log.error({ err: e }, "reset email failed"));
      await db.auditLog.create({ data: { actorId: user.id, action: "auth.reset_requested", entityType: "User", entityId: String(user.id), ip: req.ip } });
    }
    return { ok: true };
  }, loginLimit);

  const Reset = z.object({ token: z.string().min(20).max(200), password: z.string().max(200) });
  r.post("/auth/reset", "public", async (req, reply) => {
    const b = Reset.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const t = await db.passwordResetToken.findUnique({ where: { tokenHash: tokenHash(b.data.token) }, include: { user: true } });
    if (!t || t.usedAt || t.expiresAt < new Date() || t.user.status === "DISABLED") return reply.code(400).send({ error: "badToken" });
    const problem = passwordProblem(b.data.password, t.user);
    if (problem) return reply.code(422).send({ error: "password", reason: problem });
    await db.$transaction([
      db.user.update({ where: { id: t.userId }, data: { passwordHash: await hashPassword(b.data.password), status: "ACTIVE" } }),
      db.passwordResetToken.updateMany({ where: { userId: t.userId, usedAt: null }, data: { usedAt: new Date() } }),
      db.session.deleteMany({ where: { userId: t.userId } }),
      db.auditLog.create({ data: { actorId: t.userId, action: "auth.password_set", entityType: "User", entityId: String(t.userId), ip: req.ip } }),
    ]);
    return { ok: true };
  }, loginLimit);

  const Change = z.object({ current: z.string().max(200), password: z.string().max(200) });
  r.post("/auth/password", "auth", async (req, reply) => {
    const b = Change.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const user = await db.user.findUniqueOrThrow({ where: { id: req.admin!.user.id } });
    if (!(await verifyPassword(user.passwordHash, b.data.current))) return reply.code(422).send({ error: "badCredentials" });
    const problem = passwordProblem(b.data.password, user);
    if (problem) return reply.code(422).send({ error: "password", reason: problem });
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(b.data.password) } });
    await db.session.deleteMany({ where: { userId: user.id, id: { not: req.admin!.id } } });
    await audit(req, "auth.password_changed", "User", user.id);
    return { ok: true };
  });

  // Dashboard numbers, limited to what the user may see.
  r.get("/dashboard", "auth", async req => {
    const p = req.admin!.perms;
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const out: Record<string, unknown> = {};
    if (p.has("applications.view")) {
      const forms = await db.form.findMany({ where: { isBackup: false }, select: { id: true, title: true, isOpen: true } });
      out.applications = await Promise.all(forms.map(async f => ({
        ...f, total: await db.submission.count({ where: { formId: f.id, deletedAt: null } }),
        last30: await db.submission.count({ where: { formId: f.id, deletedAt: null, createdAt: { gte: since } } }),
        latest: (await db.submission.findFirst({ where: { formId: f.id, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }))?.createdAt ?? null,
      })));
    }
    if (p.has("contact.view")) out.inbox = { unread: await db.contactMessage.count({ where: { deletedAt: null, spamFlag: false, readAt: null } }), last30: await db.contactMessage.count({ where: { deletedAt: null, spamFlag: false, createdAt: { gte: since } } }) };
    if (p.has("content.edit") || p.has("content.translate_en")) {
      const [published, drafts, noEn, recent] = await Promise.all([
        db.article.count({ where: { deletedAt: null, status: "PUBLISHED" } }),
        db.article.count({ where: { deletedAt: null, status: "DRAFT" } }),
        db.article.count({ where: { deletedAt: null, status: "PUBLISHED", hideDefaultLocale: false, translations: { none: { lang: "en" } } } }),
        db.article.findMany({ where: { deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 6, include: { translations: { select: { lang: true, title: true } } } }),
      ]);
      out.content = { published, drafts, missingEnglish: noEn, recent: recent.map(a => ({ id: a.id, status: a.status, updatedAt: a.updatedAt, title: Object.fromEntries(a.translations.map(t => [t.lang, t.title])) })) };
    }
    if (p.has("audit.view")) out.audit = (await db.auditLog.findMany({ orderBy: { id: "desc" }, take: 8, include: { actor: { select: { displayName: true } } } }))
      .map(a => ({ at: a.at, actor: a.actor?.displayName ?? null, action: a.action, entityType: a.entityType, entityId: a.entityId }));
    return out;
  });

  // Everything the admin needs to start: the user, permissions, CSRF token, flags and lookups.
  r.get("/bootstrap", "auth", async req => {
    const a = req.admin!;
    const [flags, categories, programs, forms] = await Promise.all([
      db.featureFlag.findMany(),
      db.category.findMany({ include: { translations: true }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
      db.program.findMany({ include: { translations: true }, orderBy: { position: "asc" } }),
      db.form.findMany({ select: { id: true, key: true, title: true, lang: true, isOpen: true, isBackup: true }, orderBy: { id: "asc" } }),
    ]);
    return {
      user: a.user, permissions: [...a.perms], csrf: a.csrf,
      flags: Object.fromEntries(Object.keys(FLAGS).map(k => [k, flags.find(f => f.key === k)?.enabled ?? false])),
      lookups: {
        langs: ["sq", "en"],
        categories: categories.map(c => ({ id: c.id, legacyId: c.legacyId, parentId: c.parentId, isActive: c.isActive, position: c.position, name: Object.fromEntries(c.translations.map(t => [t.lang, t.name])) })),
        programs: programs.map(p => ({ id: p.id, key: p.key, name: Object.fromEntries(p.translations.map(t => [t.lang, t.name])) })),
        forms: a.perms.has("applications.view") || a.perms.has("forms.manage") ? forms : [],
      },
    };
  });
}
