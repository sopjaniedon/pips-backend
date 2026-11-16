// Admin route helper: every admin route declares its permission, which is enforced here and listed for the
// permission-matrix test. Writes need the session's CSRF token; every write is audited by the handlers.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { COOKIE, loadSession, type LoadedSession } from "../auth/session.js";
import type { Permission } from "../auth/permissions.js";

declare module "fastify" {
  interface FastifyRequest { admin?: LoadedSession }
}

/** A permission, any of several, "auth" (any signed-in user) or "public" (no session needed). */
export type Need = Permission | Permission[] | "auth" | "public";
export interface RouteInfo { method: string; url: string; need: Need }
export const ROUTES: RouteInfo[] = [];

export type AdminRequest = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: unknown }>;
type Handler = (req: AdminRequest, reply: FastifyReply) => unknown;

export const has = (req: FastifyRequest, p: Permission) => !!req.admin?.perms.has(p);
/** Article translations and HTML blocks: content editors any language, the translator English only. */
export const canEditLang = (req: FastifyRequest, lang: string) => has(req, "content.edit") || (lang === "en" && has(req, "content.translate_en"));

export function routes(app: FastifyInstance, prefix: string) {
  const { db } = app;
  async function guard(req: FastifyRequest, reply: FastifyReply, need: Need) {
    if (need === "public") return;
    const s = await loadSession(db, req.cookies[COOKIE]);
    if (!s) return reply.code(401).send({ error: "unauthenticated" });
    req.admin = s;
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["x-csrf-token"] !== s.csrf) return reply.code(403).send({ error: "csrf" });
    }
    if (need === "auth") return;
    const list = Array.isArray(need) ? need : [need];
    if (!list.some(p => s.perms.has(p))) return reply.code(403).send({ error: "forbidden" });
  }
  const add = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") =>
    (url: string, need: Need, handler: Handler, opts: RouteShorthandOptions = {}) => {
      ROUTES.push({ method, url: prefix + url, need });
      app.route({ ...opts, method, url, preHandler: (req: FastifyRequest, reply: FastifyReply) => guard(req, reply, need), handler } as never);
    };
  return { get: add("GET"), post: add("POST"), put: add("PUT"), patch: add("PATCH"), del: add("DELETE") };
}

/** Writes one audit row for the signed-in user. Never put personal data in meta. */
export async function audit(req: FastifyRequest, action: string, entityType: string, entityId?: string | number | null, meta?: Record<string, unknown>, reason?: string | null) {
  await req.server.db.auditLog.create({
    data: {
      actorId: req.admin?.user.id ?? null, action, entityType, entityId: entityId == null ? null : String(entityId),
      reason: reason ?? null, ip: req.ip, userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null, meta: (meta ?? undefined) as never,
    },
  });
}

export const page = (q: { page?: unknown; pageSize?: unknown }, max = 100) => {
  const size = Math.min(Math.max(Number(q.pageSize) || 25, 1), max);
  const p = Math.max(Number(q.page) || 1, 1);
  return { take: size, skip: (p - 1) * size, page: p, pageSize: size };
};
