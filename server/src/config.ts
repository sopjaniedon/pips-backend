import { z } from "zod";

// All configuration comes from the environment (.env locally, never committed).
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PII_KEYS: z.string().transform((s, ctx) => {
    try {
      const keys = JSON.parse(s) as Record<string, string>;
      for (const [kid, b64] of Object.entries(keys)) {
        if (Buffer.from(b64, "base64").length !== 32) ctx.addIssue({ code: "custom", message: `PII key ${kid} must be 32 bytes` });
      }
      return keys;
    } catch {
      ctx.addIssue({ code: "custom", message: "PII_KEYS must be JSON" });
      return z.NEVER;
    }
  }),
  PII_ACTIVE_KID: z.string(),
  STORAGE_DIR: z.string().default("./data/storage"),
  WEB_DIR: z.string().default("./web"),
  MAIL_MODE: z.enum(["capture", "live"]).default("capture"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  MAIL_FROM: z.string().default("PIPS <no-reply@pips-ks.org>"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (!(cfg.PII_ACTIVE_KID in cfg.PII_KEYS)) throw new Error("PII_ACTIVE_KID is not one of PII_KEYS");
  // Mail guard: real email only from production; anything else must go to a local capture server.
  if (cfg.MAIL_MODE === "live" && cfg.NODE_ENV !== "production") throw new Error("MAIL_MODE=live is only allowed in production");
  if (cfg.MAIL_MODE === "capture" && !["localhost", "127.0.0.1", "mailpit"].includes(cfg.SMTP_HOST)) {
    throw new Error("MAIL_MODE=capture requires SMTP_HOST to be localhost or mailpit");
  }
  return cfg;
}
