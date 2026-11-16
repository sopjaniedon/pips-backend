import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const REPO_ROOT = resolve(process.cwd(), "..");
export const STORAGE_DIR = resolve(REPO_ROOT, process.env.STORAGE_DIR ?? "./data/storage");
export const PORTALS_DIR = process.env.LEGACY_PORTALS_DIR ?? "";

/**
 * Key for matching legacy paths: "/portals/0/…", NFC, lower-case, URL-decoded, "\" → "/", without DNN's ".resources" suffix.
 * On-disk names are NFD (macOS/OneDrive copy) while the DB stores NFC, so both sides go through this.
 */
export function legacyKey(p: string): string {
  let s = p.trim();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/\\/g, "/").replace(/^https?:\/\/(www\.)?pips-ks\.org/i, "");
  if (!s.startsWith("/")) s = "/" + s;
  return s.normalize("NFC").toLowerCase().replace(/\/{2,}/g, "/").replace(/\.resources$/, "");
}

/** Walk Portals and return key → absolute path for every file. */
export async function indexPortals(): Promise<Map<string, string>> {
  if (!PORTALS_DIR || !existsSync(PORTALS_DIR)) throw new Error(`LEGACY_PORTALS_DIR not found: ${PORTALS_DIR}`);
  const out = new Map<string, string>();
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name !== ".DS_Store") out.set(legacyKey("/Portals/" + relative(PORTALS_DIR, abs)), abs);
    }
  }
  await walk(PORTALS_DIR);
  return out;
}

/** EasyDNN / DNN generated variants and caches: never migrated (the new system makes its own). */
export function isGenerated(key: string): boolean {
  return /\/easydnnnews\/\d+\/(thumbs\/|\d+\d+[pc]\d+edn(thumb|main))/.test(key)
    || /\/easydnnnews\/\d+\/\d{3,}[pc]\d+edn/.test(key)
    || /\/easygalleryimages\/\d+\/\d+\/thumb[^/]*$/.test(key)
    || key.includes("/easydnnrotator/") || key.startsWith("/portals/_default/") || key.startsWith("/portals/0-system/")
    || /\/(cache|_imagecache)\//.test(key);
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", heic: "image/heic", ico: "image/x-icon", pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", rtf: "application/rtf",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain",
  css: "text/css", xml: "application/xml",
};
export const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name.replace(/\.resources$/i, ""))?.[1] ?? "bin").toLowerCase();
export const mimeOf = (ext: string) => MIME[ext] ?? "application/octet-stream";
export const isRaster = (ext: string) => ["jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "heic"].includes(ext);

/** sha256 of a file, streamed. */
export async function sha256File(abs: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(abs), new Transform({ transform(chunk, _e, cb) { h.update(chunk); cb(); } }));
  return h.digest("hex");
}

/** Content-addressed copy: storage/<bucket>/<sha[0:2]>/<sha>.<ext>. Hashes while copying; never overwrites. */
export async function storeFile(abs: string, bucket: "public" | "private"): Promise<{ sha: string; key: string; size: number; ext: string }> {
  const ext = extOf(abs);
  const tmp = join(STORAGE_DIR, "tmp", `${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dirname(tmp), { recursive: true });
  const h = createHash("sha256");
  await pipeline(createReadStream(abs), new Transform({ transform(chunk, _e, cb) { h.update(chunk); cb(null, chunk); } }), createWriteStream(tmp, { mode: bucket === "private" ? 0o600 : 0o644 }));
  const sha = h.digest("hex");
  const key = `${bucket}/${sha.slice(0, 2)}/${sha}.${ext}`;
  const dest = join(STORAGE_DIR, key);
  if (existsSync(dest)) unlinkSync(tmp);
  else { mkdirSync(dirname(dest), { recursive: true, mode: bucket === "private" ? 0o700 : 0o755 }); renameSync(tmp, dest); }
  return { sha, key, size: statSync(dest).size, ext };
}

/** Run async work with bounded concurrency. */
export async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}
