// Image variants for uploads made in the admin (same as migration step 07): webp 400/800/1600, auto-rotated,
// metadata stripped. HEIC is decoded with heic-convert and also gets a JPEG copy.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import type { File, PrismaClient } from "@prisma/client";

const WIDTHS = [400, 800, 1600] as const;
export const isRaster = (ext: string) => ["jpg", "jpeg", "png", "gif", "webp", "heic", "jfif"].includes(ext.toLowerCase());

async function decode(abs: string, ext: string): Promise<Buffer | string> {
  try { await sharp(abs, { failOn: "none" }).resize(8).toBuffer(); return abs; } catch {
    if (ext !== "heic") throw new Error("undecodable image");
    const { default: convert } = await import("heic-convert");
    return Buffer.from(await convert({ buffer: await readFile(abs), format: "JPEG", quality: 0.9 }));
  }
}

export async function makeVariants(db: PrismaClient, storageDir: string, f: File): Promise<number> {
  if (!isRaster(f.ext)) return 0;
  const bucket = f.bucket.toLowerCase();
  const input = await decode(join(storageDir, f.storageKey), f.ext);
  const meta = await sharp(input, { failOn: "none" }).metadata();
  if (meta.width && meta.height && !f.width) await db.file.update({ where: { id: f.id }, data: { width: meta.width, height: meta.height } });
  // Private images (applicant photos) only get a small thumbnail.
  const widths = f.bucket === "PRIVATE" ? [400] : [...WIDTHS];
  let n = 0;
  for (const w of widths) {
    const key = `${bucket}/v/${f.sha256.slice(0, 2)}/${f.sha256}-w${w}.webp`;
    const dest = join(storageDir, key);
    await mkdir(dirname(dest), { recursive: true });
    const info = await sharp(input, { failOn: "none" }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(dest);
    await db.fileVariant.upsert({
      where: { fileId_kind: { fileId: f.id, kind: `w${w}` } },
      update: { storageKey: key, mime: "image/webp", width: info.width, height: info.height, size: info.size },
      create: { fileId: f.id, kind: `w${w}`, storageKey: key, mime: "image/webp", width: info.width, height: info.height, size: info.size },
    });
    n++;
  }
  if (f.ext === "heic" && typeof input !== "string") {
    const key = `${bucket}/v/${f.sha256.slice(0, 2)}/${f.sha256}.jpg`;
    const dest = join(storageDir, key);
    const info = await sharp(input).rotate().jpeg({ quality: 88 }).toFile(dest);
    await db.fileVariant.upsert({
      where: { fileId_kind: { fileId: f.id, kind: "jpeg" } },
      update: { storageKey: key, mime: "image/jpeg", width: info.width, height: info.height, size: info.size },
      create: { fileId: f.id, kind: "jpeg", storageKey: key, mime: "image/jpeg", width: info.width, height: info.height, size: info.size },
    });
    n++;
  }
  return n;
}
