// Contact inbox (DNN Feedback), users and roles, site settings, page SEO, redirects, audit log and feature flags.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { FLAGS } from "../auth/permissions.js";
import { issueResetToken } from "../auth/session.js";
import type { Mailer } from "../lib/mailer.js";
import { normPath } from "../lib/legacy.js";
import { invalidateSiteData } from "../site/data.js";
import { INVITE_TTL, resetMail } from "./auth.js";
import { audit, page, routes } from "./registry.js";

const Id = z.coerce.number().int().positive();

export async function orgRoutes(app: FastifyInstance, mailer: Mailer) {
  const { db, config } = app;
  const r = routes(app, "/api/admin");

  // ─── Contact inbox ───
  r.get("/contact", "contact.view", async req => {
    const q = req.query as Record<string, string>;
    const pg = page(q);
    const where: Prisma.ContactMessageWhereInput = { deletedAt: null };
    if (q.spam === "1") where.spamFlag = true; else if (q.spam !== "all") where.spamFlag = false;
    if (q.unread === "1") where.readAt = null;
    if (q.lang === "sq" || q.lang === "en") where.lang = q.lang;
    if (q.q) where.OR = [{ name: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }, { subject: { contains: q.q, mode: "insensitive" } }, { message: { contains: q.q, mode: "insensitive" } }];
    const [total, rows, unread] = await Promise.all([
      db.contactMessage.count({ where }),
      db.contactMessage.findMany({ where, orderBy: { createdAt: "desc" }, take: pg.take, skip: pg.skip }),
      db.contactMessage.count({ where: { deletedAt: null, spamFlag: false, readAt: null } }),
    ]);
    return { total, unread, page: pg.page, pageSize: pg.pageSize, items: rows.map(m => ({ id: m.id, lang: m.lang, name: m.name, email: m.email, subject: m.subject, excerpt: m.message.slice(0, 160), spamFlag: m.spamFlag, readAt: m.readAt, createdAt: m.createdAt })) };
  });
  r.get("/contact/:id", "contact.view", async (req, reply) => {
    const m = await db.contactMessage.findFirst({ where: { id: Id.parse(req.params.id), deletedAt: null } });
    if (!m) return reply.code(404).send({ error: "notFound" });
    if (!m.readAt) await db.contactMessage.update({ where: { id: m.id }, data: { readAt: new Date() } });
    await audit(req, "contact.view", "ContactMessage", m.id);
    return m;
  });
  r.patch("/contact/:id", "contact.view", async (req, reply) => {
    const b = z.object({ spamFlag: z.boolean(), read: z.boolean() }).partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const id = Id.parse(req.params.id);
    const res = await db.contactMessage.updateMany({ where: { id, deletedAt: null }, data: { spamFlag: b.data.spamFlag, readAt: b.data.read === undefined ? undefined : b.data.read ? new Date() : null } });
    if (!res.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "contact.update", "ContactMessage", id, b.data);
    return { ok: true };
  });
  r.del("/contact/:id", "contact.view", async (req, reply) => {
    const id = Id.parse(req.params.id);
    const res = await db.contactMessage.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (!res.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "contact.delete", "ContactMessage", id);
    return { ok: true };
  });

  // ─── Users and roles ───
  const userDto = (u: Prisma.UserGetPayload<{ include: { roles: { include: { role: true } } } }>) => ({
    id: u.id, username: u.username, email: u.email, firstName: u.firstName, lastName: u.lastName, displayName: u.displayName,
    status: u.status, isSuperUser: u.isSuperUser, roles: u.roles.map(x => x.role.key), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, hasPassword: !!u.passwordHash,
  });
  r.get("/users", "users.manage", async () => {
    const [users, roles] = await Promise.all([db.user.findMany({ include: { roles: { include: { role: true } } }, orderBy: { id: "asc" } }), db.role.findMany({ orderBy: { id: "asc" } })]);
    return { roles: roles.map(x => ({ key: x.key, name: x.name })), items: users.map(userDto) };
  });
  const UserIn = z.object({
    email: z.string().email().max(254), username: z.string().regex(/^[\w.@-]{2,100}$/), firstName: z.string().max(100), lastName: z.string().max(100),
    displayName: z.string().trim().min(1).max(200), roles: z.array(z.enum(["administrator", "editor", "translator_en"])).max(3), status: z.enum(["INVITED", "ACTIVE", "DISABLED"]),
  });
  async function setRoles(userId: number, keys: string[]) {
    const roles = await db.role.findMany({ where: { key: { in: keys } } });
    await db.userRole.deleteMany({ where: { userId } });
    await db.userRole.createMany({ data: roles.map(x => ({ userId, roleId: x.id })) });
  }
  async function invite(userId: number) {
    const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const token = await issueResetToken(db, u.id, INVITE_TTL);
    await mailer.send({ to: u.email, ...resetMail(config.PUBLIC_BASE_URL, token, true, u.displayName) });
  }
  r.post("/users", "users.manage", async (req, reply) => {
    const b = UserIn.omit({ status: true }).partial({ firstName: true, lastName: true, username: true }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const email = b.data.email.toLowerCase();
    if (await db.user.findFirst({ where: { OR: [{ email }, { username: b.data.username ?? email }] } })) return reply.code(409).send({ error: "exists" });
    const u = await db.user.create({ data: { email, username: b.data.username ?? email, firstName: b.data.firstName ?? "", lastName: b.data.lastName ?? "", displayName: b.data.displayName, status: "INVITED" } });
    await setRoles(u.id, b.data.roles);
    await invite(u.id).catch(e => req.log.error({ err: e }, "invite email failed"));
    await audit(req, "user.create", "User", u.id, { roles: b.data.roles });
    return { id: u.id };
  });
  r.put("/users/:id", "users.manage", async (req, reply) => {
    const b = UserIn.partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const id = Id.parse(req.params.id);
    const u = await db.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
    if (!u) return reply.code(404).send({ error: "notFound" });
    const self = id === req.admin!.user.id;
    // Nobody can lock themselves out.
    if (self && (b.data.status === "DISABLED" || (b.data.roles && !b.data.roles.includes("administrator") && !u.isSuperUser))) return reply.code(409).send({ error: "self" });
    if (b.data.status === "ACTIVE" && !u.passwordHash) return reply.code(409).send({ error: "noPassword" });
    const { roles, ...data } = b.data;
    await db.user.update({ where: { id }, data: { ...data, email: data.email?.toLowerCase() } });
    if (roles) await setRoles(id, roles);
    if (b.data.status === "DISABLED" || roles) await db.session.deleteMany({ where: { userId: id, ...(self ? { id: { not: req.admin!.id } } : {}) } });
    await audit(req, "user.update", "User", id, { fields: Object.keys(b.data), roles });
    return { ok: true };
  });
  r.post("/users/:id/invite", "users.manage", async (req, reply) => {
    const id = Id.parse(req.params.id);
    const u = await db.user.findUnique({ where: { id } });
    if (!u || u.status === "DISABLED") return reply.code(404).send({ error: "notFound" });
    await invite(id);
    await audit(req, "user.invite", "User", id);
    return { ok: true };
  });

  // ─── Site settings (DNN portal settings) ───
  const SETTING_KEYS: Record<string, z.ZodTypeAny> = {
    "site.name": z.record(z.string().max(300).nullable()),
    "site.description": z.record(z.string().max(2000).nullable()),
    "site.keywords": z.record(z.string().max(2000).nullable()),
    "site.footerText": z.record(z.string().max(1000).nullable()),
    "site.social": z.record(z.string().url().max(500)),
    "analytics.headHtml": z.string().max(10000).nullable(),
    "contact.settings": z.record(z.object({
      sendTo: z.string().max(1000).nullable(), sendCopy: z.boolean().optional(), maxMessage: z.number().int().min(100).max(20000),
      fields: z.record(z.enum(["required", "optional", "hidden"])), captcha: z.string().optional(), moderated: z.boolean().optional(),
    })),
  };
  r.get("/settings", "settings.manage", async () => {
    const rows = await db.setting.findMany({ where: { key: { in: Object.keys(SETTING_KEYS) } } });
    return Object.fromEntries(Object.keys(SETTING_KEYS).map(k => [k, rows.find(x => x.key === k)?.value ?? null]));
  });
  r.put("/settings/:key", "settings.manage", async (req, reply) => {
    const schema = SETTING_KEYS[req.params.key];
    if (!schema) return reply.code(404).send({ error: "notFound" });
    const b = schema.safeParse((req.body as { value?: unknown })?.value);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    await db.setting.upsert({ where: { key: req.params.key }, update: { value: b.data as Prisma.InputJsonValue }, create: { key: req.params.key, value: b.data as Prisma.InputJsonValue } });
    await audit(req, "setting.update", "Setting", req.params.key);
    invalidateSiteData();
    return { ok: true };
  });

  // ─── Page SEO (DNN page settings: title, description, keywords) ───
  r.get("/pages", "settings.manage", async () => db.pageMeta.findMany({ orderBy: [{ routeKey: "asc" }, { lang: "asc" }] }));
  r.put("/pages/:id", "settings.manage", async (req, reply) => {
    const b = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(1000).nullable(), keywords: z.string().max(1000).nullable() }).partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const id = Id.parse(req.params.id);
    const res = await db.pageMeta.updateMany({ where: { id }, data: b.data });
    if (!res.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "page.update", "PageMeta", id, { fields: Object.keys(b.data) });
    return { ok: true };
  });

  // ─── Redirects (DNN TabUrls + old page paths) ───
  r.get("/redirects", "redirects.manage", async req => {
    const q = req.query as Record<string, string>;
    const pg = page(q, 200);
    const where: Prisma.RedirectWhereInput = q.q ? { OR: [{ fromPath: { contains: q.q.toLowerCase() } }, { toPath: { contains: q.q, mode: "insensitive" } }] } : {};
    const [total, items] = await Promise.all([db.redirect.count({ where }), db.redirect.findMany({ where, orderBy: { fromPath: "asc" }, take: pg.take, skip: pg.skip })]);
    return { total, page: pg.page, pageSize: pg.pageSize, items };
  });
  const RedirectIn = z.object({ fromPath: z.string().min(2).max(1000).startsWith("/"), toPath: z.string().max(2000).nullable(), code: z.union([z.literal(301), z.literal(302), z.literal(410)]) });
  r.post("/redirects", "redirects.manage", async (req, reply) => {
    const b = RedirectIn.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    if (b.data.code !== 410 && !b.data.toPath) return reply.code(400).send({ error: "toPath" });
    const fromPath = normPath(b.data.fromPath);
    if (await db.redirect.findUnique({ where: { fromPath } })) return reply.code(409).send({ error: "exists" });
    const x = await db.redirect.create({ data: { fromPath, toPath: b.data.toPath, code: b.data.code, source: "MANUAL" } });
    await audit(req, "redirect.create", "Redirect", x.id);
    return x;
  });
  r.put("/redirects/:id", "redirects.manage", async (req, reply) => {
    const b = RedirectIn.partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const id = Id.parse(req.params.id);
    const res = await db.redirect.updateMany({ where: { id }, data: { ...b.data, fromPath: b.data.fromPath ? normPath(b.data.fromPath) : undefined } });
    if (!res.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "redirect.update", "Redirect", id, { fields: Object.keys(b.data) });
    return { ok: true };
  });
  r.del("/redirects/:id", "redirects.manage", async (req, reply) => {
    const id = Id.parse(req.params.id);
    const res = await db.redirect.deleteMany({ where: { id } });
    if (!res.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "redirect.delete", "Redirect", id);
    return { ok: true };
  });

  // ─── Audit log (read-only; the table rejects UPDATE and DELETE) ───
  r.get("/audit", "audit.view", async req => {
    const q = req.query as Record<string, string>;
    const pg = page(q, 200);
    const where: Prisma.AuditLogWhereInput = {};
    if (q.action) where.action = { startsWith: q.action };
    if (q.entityType) where.entityType = q.entityType;
    if (q.entityId) where.entityId = q.entityId;
    if (q.actor) where.actorId = Number(q.actor);
    const [total, rows] = await Promise.all([db.auditLog.count({ where }), db.auditLog.findMany({ where, orderBy: { id: "desc" }, take: pg.take, skip: pg.skip, include: { actor: { select: { displayName: true } } } })]);
    return { total, page: pg.page, pageSize: pg.pageSize, items: rows.map(a => ({ id: Number(a.id), at: a.at, actor: a.actor?.displayName ?? null, actorId: a.actorId, action: a.action, entityType: a.entityType, entityId: a.entityId, reason: a.reason, ip: a.ip, meta: a.meta })) };
  });

  // ─── Feature flags (prototype extras, all off) ───
  r.get("/flags", "flags.manage", async () => {
    const rows = await db.featureFlag.findMany();
    return Object.entries(FLAGS).map(([key, description]) => ({ key, description, enabled: rows.find(x => x.key === key)?.enabled ?? false }));
  });
  r.put("/flags/:key", "flags.manage", async (req, reply) => {
    if (!(req.params.key in FLAGS)) return reply.code(404).send({ error: "notFound" });
    const b = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    await db.featureFlag.upsert({ where: { key: req.params.key }, update: { enabled: b.data.enabled }, create: { key: req.params.key, enabled: b.data.enabled, description: FLAGS[req.params.key] } });
    await audit(req, "flag.update", "FeatureFlag", req.params.key, { enabled: b.data.enabled });
    return { ok: true };
  });
}
