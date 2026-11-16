// Spam protection for public forms (DNN had none: captcha off): honeypot field, signed time token, rate limits
// (set on the routes) and a content heuristic that flags but never drops messages.
import { createHmac, timingSafeEqual } from "node:crypto";

export const HONEYPOT = "website";
const MIN_SECONDS = 3;
const MAX_SECONDS = 3 * 24 * 3600;

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** Token embedded in the page: which form, and when the page was served. */
export function issueToken(secret: string, form: string, now = Date.now()): string {
  const payload = `${form}.${now}`;
  return `${payload}.${sign(secret, payload)}`;
}

export type TokenCheck = "ok" | "missing" | "invalid" | "too-fast" | "expired";
export function checkToken(secret: string, form: string, token: unknown, now = Date.now()): TokenCheck {
  if (typeof token !== "string" || !token) return "missing";
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== form) return "invalid";
  const expected = Buffer.from(sign(secret, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  const age = (now - Number(parts[1])) / 1000;
  if (!(age >= MIN_SECONDS)) return "too-fast";
  if (age > MAX_SECONDS) return "expired";
  return "ok";
}

const SPAM_WORDS = /\b(casino|viagra|cialis|crypto|bitcoin|forex|loan|porn|sex|seo services|backlinks|escort|betting|essay writing)\b/i;
/** Same heuristic the migration used for the legacy inbox. */
export function looksLikeSpam(...texts: (string | null | undefined)[]): boolean {
  const all = texts.filter(Boolean).join(" ");
  return (all.match(/https?:\/\//gi) ?? []).length >= 2 || SPAM_WORDS.test(all);
}
