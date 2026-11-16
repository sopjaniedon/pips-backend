// Admin API (/api/admin/*). Every route declares its permission (registry.ts); writes need the CSRF header.
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { FLAGS, ROLE_PERMISSIONS } from "../auth/permissions.js";
import { createMailer } from "../lib/mailer.js";
import { paths } from "../lib/paths.js";
import { authRoutes } from "./auth.js";
import { contentRoutes } from "./content.js";
import { formsAdminRoutes } from "./forms.js";
import { orgRoutes } from "./org.js";

/** Roles, their permission rows and the feature flags exist on every start (idempotent). */
export async function ensureAccessModel(app: FastifyInstance) {
  const { db } = app;
  const names: Record<string, string> = { administrator: "Administrator", editor: "Editor", translator_en: "Translator (English)" };
  for (const [key, perms] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await db.role.upsert({ where: { key }, update: {}, create: { key, name: names[key] ?? key } });
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permission: { notIn: [...perms] } } });
    await db.rolePermission.createMany({ data: perms.map(permission => ({ roleId: role.id, permission })), skipDuplicates: true });
  }
  await db.featureFlag.createMany({ data: Object.entries(FLAGS).map(([key, description]) => ({ key, description, enabled: false })), skipDuplicates: true });
}

export async function adminPlugin(app: FastifyInstance) {
  const { config } = app;
  const { storageDir } = paths(config);
  const mailer = createMailer(config);
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 50, fields: 50 } });
  // reply.sendFile() for private files; nothing is served from here directly.
  await app.register(fastifyStatic, { root: storageDir, serve: false });
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.getHeader("cache-control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  await authRoutes(app, mailer);
  await contentRoutes(app);
  await formsAdminRoutes(app);
  await orgRoutes(app, mailer);
}
