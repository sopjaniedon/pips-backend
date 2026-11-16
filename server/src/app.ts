import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import { PrismaClient } from "@prisma/client";
import type { Config } from "./config.js";
import { sitePlugin } from "./site/plugin.js";
import { formsPlugin } from "./forms/plugin.js";
import { adminPlugin, ensureAccessModel } from "./admin/plugin.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: PrismaClient;
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      // Never log request bodies or cookies: forms carry personal data.
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
    },
    trustProxy: true,
    bodyLimit: 1_000_000,
    routerOptions: { maxParamLength: 500 }, // legacy document file names can be long (up to ~170 characters)
  });

  const db = new PrismaClient();
  app.decorate("config", config);
  app.decorate("db", db);
  app.addHook("onClose", async () => db.$disconnect());

  await app.register(helmet, { contentSecurityPolicy: false }); // CSP is set per page in the site renderer (P4)
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { global: false });
  await app.register(compress, { global: true, threshold: 1024 });

  app.get("/health", async (_req, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: "ok", db: "ok" };
    } catch {
      return reply.code(503).send({ status: "degraded", db: "unreachable" });
    }
  });

  await ensureAccessModel(app);
  await app.register(adminPlugin, { prefix: "/api/admin" });
  await app.register(formsPlugin);
  await app.register(sitePlugin);
  return app;
}
