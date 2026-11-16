// Field-level encryption for sensitive applicant data (passport number and dates, issuing authority).
// AES-256-GCM with a per-value random IV and associated data binding the value to its row and field,
// so a ciphertext copied to another row or field fails to decrypt. Keys are versioned by key id (kid)
// for rotation; keys live only in the environment (PII_KEYS), never in the database or the repo.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;

export interface Keyring {
  keys: Record<string, Buffer>;
  activeKid: string;
}

export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = JSON.parse(env.PII_KEYS ?? "{}") as Record<string, string>;
  const keys = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Buffer.from(v, "base64")]));
  const activeKid = env.PII_ACTIVE_KID ?? "";
  if (!keys[activeKid] || keys[activeKid].length !== 32) throw new Error("PII_ACTIVE_KID must name a 32-byte key in PII_KEYS");
  return { keys, activeKid };
}

/** Returns [version|iv(12)|tag(16)|ciphertext] and the key id used. */
export function encryptField(ring: Keyring, plain: string, aad: string): { enc: Buffer; kid: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.keys[ring.activeKid], iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { enc: Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]), kid: ring.activeKid };
}

export function decryptField(ring: Keyring, enc: Uint8Array, kid: string, aad: string): string {
  const buf = Buffer.from(enc);
  if (buf[0] !== VERSION) throw new Error("unknown ciphertext version");
  const key = ring.keys[kid];
  if (!key) throw new Error(`no key for kid ${kid}`);
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
}

/** Associated data for a submission value. */
export const valueAad = (submissionId: number, fieldId: number) => `submission:${submissionId}:field:${fieldId}`;

/** Masked display, e.g. "•••••123". */
export function mask(plain: string | null | undefined, visible = 3): string {
  if (!plain) return "";
  return "•".repeat(Math.max(3, plain.length - visible)) + plain.slice(-visible);
}
