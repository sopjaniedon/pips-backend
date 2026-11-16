import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { STORAGE_DIR, extOf, indexPortals, isGenerated, isRaster, legacyKey, mimeOf, pool, sha256File, storeFile } from "../lib/files.js";
import type { Step } from "./types.js";

const PRIVATE_PREFIX = "/portals/0/digform/";
const bucketOf = (key: string) => (key.startsWith(PRIVATE_PREFIX) ? "PRIVATE" : "PUBLIC") as "PRIVATE" | "PUBLIC";
const folderOf = (key: string) => key.split("/").slice(0, 4).join("/"); // /portals/0/<folder>
const PORTAL_REF = /(?:https?:\/\/(?:www\.)?pips-ks\.org)?(\/portals\/0\/[^"'\s)<>?#]+)/gi;

/** Every file the database refers to, keyed by legacyKey(). */
async function collectReferences(): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const add = (p: string | null | undefined) => { if (p && p.trim()) refs.set(legacyKey(p), p.trim()); };

  for (const a of await db.article.findMany({ where: { legacyCoverPath: { not: null } }, select: { legacyCoverPath: true } })) add(a.legacyCoverPath);
  for (const d of await db.document.findMany({ select: { legacyPath: true } })) add(d.legacyPath);
  for (const g of await db.galleryItem.findMany({ where: { mediaType: "IMAGE", legacyPath: { not: null } }, select: { legacyPath: true } })) add(g.legacyPath);
  for (const s of await db.setting.findMany({ where: { key: { in: ["site.logoLegacyPath", "site.faviconLegacyPath"] } } })) add(typeof s.value === "string" ? s.value : null);

  const htmls = [
    ...(await db.htmlBlock.findMany({ select: { html: true } })).map(x => x.html),
    ...(await db.htmlBlockRevision.findMany({ select: { html: true } })).map(x => x.html),
    ...(await db.articleTranslation.findMany({ select: { bodyHtml: true } })).map(x => x.bodyHtml),
  ];
  for (const h of htmls) for (const m of h.matchAll(PORTAL_REF)) add(m[1]);

  // Applicant uploads (DigForm file fields, FieldType 25): ValueText = "<AttachmentKey>/<FieldID>_<name>"
  const uploads = await select<{ ValueText: string }>(
    "SELECT d.ValueText FROM DigFormItemData d JOIN DigFormField f ON f.FieldID = d.FieldID WHERE f.FieldType = 25 AND d.ValueText IS NOT NULL AND LEN(d.ValueText) > 0",
  );
  for (const u of uploads) add(`/Portals/0/DigForm/${u.ValueText.replace(/^\/+/, "")}`);
  return refs;
}

export const fileIndexStep: Step = {
  id: "05",
  name: "file index: match every database reference to a file on disk (NFC, case-insensitive)",
  async run() {
    const disk = await indexPortals();
    const refs = await collectReferences();
    let found = 0, missingPublic = 0, missingPrivate = 0;
    for (const [key, original] of refs) {
      const ok = disk.has(key);
      if (ok) found++; else if (bucketOf(key) === "PRIVATE") missingPrivate++; else missingPublic++;
      await db.legacyPath.upsert({ where: { path: key }, update: { originalPath: original.normalize("NFC"), found: ok }, create: { path: key, originalPath: original.normalize("NFC"), found: ok } });
    }
    // What we deliberately leave behind: generated variants/caches and unreferenced files (counts and bytes per folder only).
    let genN = 0, genBytes = 0;
    const orphans: Record<string, { n: number; bytes: number }> = {};
    for (const [key, abs] of disk) {
      if (refs.has(key)) continue;
      const size = statSync(abs).size;
      if (isGenerated(key)) { genN++; genBytes += size; continue; }
      const f = folderOf(key);
      orphans[f] ??= { n: 0, bytes: 0 };
      orphans[f].n++; orphans[f].bytes += size;
    }
    const counts: Record<string, number> = {
      filesOnDisk: disk.size, references: refs.size, found, missingPublic, missingPrivate,
      generatedSkipped: genN, generatedSkippedMB: Math.round(genBytes / 1e6),
    };
    for (const [f, o] of Object.entries(orphans)) { counts[`orphans${f.replace("/portals/0", "")}`] = o.n; counts[`orphansMB${f.replace("/portals/0", "")}`] = Math.round(o.bytes / 1e6); }
    return counts;
  },
};

export const fileCopyStep: Step = {
  id: "06",
  name: "file copy: content-addressed storage (sha256), de-duplicated; applicant files in the private bucket",
  async run() {
    const disk = await indexPortals();
    const paths = await db.legacyPath.findMany({ where: { found: true }, include: { file: true } });
    let copied = 0, reused = 0, bytes = 0;
    await pool(paths, 4, async lp => {
      const abs = disk.get(lp.path);
      if (!abs) return;
      const bucket = bucketOf(lp.path);
      // Already imported and still on disk with the same size → skip re-reading gigabytes on re-runs.
      if (lp.file && existsSync(join(STORAGE_DIR, lp.file.storageKey)) && Number(lp.file.size) === statSync(abs).size) { reused++; return; }
      const s = await storeFile(abs, bucket === "PRIVATE" ? "private" : "public");
      const name = basename(lp.originalPath).normalize("NFC").replace(/\.resources$/i, "");
      const originalName = bucket === "PRIVATE" ? name.replace(/^\d+_/, "") : name;
      // Identical content under several legacy paths can race here: on a unique conflict, reuse the row the other worker made.
      const where = { bucket_sha256: { bucket, sha256: s.sha } };
      const file = await db.file.upsert({
        where, update: {},
        create: { bucket, sha256: s.sha, size: BigInt(s.size), mime: mimeOf(s.ext), ext: s.ext, originalName, storageKey: s.key },
      }).catch(async e => {
        if ((e as { code?: string }).code !== "P2002") throw e;
        return db.file.findUniqueOrThrow({ where });
      });
      // Same content stored before under another extension: keep the one copy the row points to.
      if (file.storageKey !== s.key) rmSync(join(STORAGE_DIR, s.key), { force: true });
      await db.legacyPath.update({ where: { path: lp.path }, data: { fileId: file.id } });
      copied++; bytes += s.size;
    });

    // Link content rows to their files.
    const byKey = new Map((await db.legacyPath.findMany({ where: { fileId: { not: null } }, select: { path: true, fileId: true } })).map(p => [p.path, p.fileId!]));
    let covers = 0, docs = 0, gallery = 0;
    for (const a of await db.article.findMany({ where: { legacyCoverPath: { not: null } }, select: { id: true, legacyCoverPath: true } })) {
      const fileId = byKey.get(legacyKey(a.legacyCoverPath!)) ?? null;
      if (fileId) covers++;
      await db.article.update({ where: { id: a.id }, data: { coverFileId: fileId } });
    }
    for (const d of await db.document.findMany({ select: { id: true, legacyPath: true } })) {
      const fileId = byKey.get(legacyKey(d.legacyPath)) ?? null;
      if (fileId) docs++;
      await db.document.update({ where: { id: d.id }, data: { fileId } });
    }
    for (const g of await db.galleryItem.findMany({ where: { legacyPath: { not: null } }, select: { id: true, legacyPath: true } })) {
      const fileId = byKey.get(legacyKey(g.legacyPath!)) ?? null;
      if (fileId) gallery++;
      await db.galleryItem.update({ where: { id: g.id }, data: { fileId } });
    }
    const stats = await db.$queryRawUnsafe<{ bucket: string; n: bigint; bytes: bigint }[]>(`SELECT bucket, count(*) n, coalesce(sum(size),0) bytes FROM "File" GROUP BY bucket ORDER BY bucket`);
    const out: Record<string, number> = { legacyPathsFound: paths.length, copiedThisRun: copied, copiedMBThisRun: Math.round(bytes / 1e6), alreadyStored: reused, coversLinked: covers, documentsLinked: docs, galleryLinked: gallery };
    for (const s of stats) { out[`files.${s.bucket}`] = Number(s.n); out[`MB.${s.bucket}`] = Math.round(Number(s.bytes) / 1e6); }
    out.duplicatesRemoved = paths.length - stats.reduce((n, s) => n + Number(s.n), 0);
    return out;
  },
};

const WIDTHS = [400, 800, 1600] as const;

/**
 * Decode any raster into something sharp can process. sharp (libvips) cannot decode HEVC-based HEIC or BMP:
 * HEIC goes through heic-convert (→ JPEG buffer), BMP through bmp-js (→ raw RGBA). Decoding is lenient so a
 * slightly malformed EXIF block doesn't reject an otherwise valid photo.
 */
type Decoded = { input: Buffer | string; raw?: { width: number; height: number; channels: 4 }; jpeg?: Buffer };
async function decodable(abs: string, ext: string): Promise<Decoded> {
  const { readFileSync } = await import("node:fs");
  if (ext === "bmp") {
    const { decode } = await import("bmp-js");
    const bmp = decode(readFileSync(abs));
    // bmp-js returns ABGR; swap to RGBA for sharp
    const rgba = Buffer.alloc(bmp.data.length);
    for (let i = 0; i < bmp.data.length; i += 4) { rgba[i] = bmp.data[i + 3]; rgba[i + 1] = bmp.data[i + 2]; rgba[i + 2] = bmp.data[i + 1]; rgba[i + 3] = 255; }
    return { input: rgba, raw: { width: bmp.width, height: bmp.height, channels: 4 } };
  }
  try { await sharp(abs, { failOn: "none" }).resize(8).toBuffer(); return { input: abs }; } catch {
    if (ext !== "heic") throw new Error("undecodable image");
    const { default: convert } = await import("heic-convert");
    const jpeg = Buffer.from(await convert({ buffer: readFileSync(abs), format: "JPEG", quality: 0.9 }));
    return { input: jpeg, jpeg };
  }
}
const open = (d: Decoded) => sharp(d.input, { failOn: "none", ...(d.raw ? { raw: d.raw } : {}) });

export const variantsStep: Step = {
  id: "07",
  name: "image variants: webp 400/800/1600 (public), 400 thumbnails (private); EXIF stripped, auto-rotated",
  async run() {
    const files = await db.file.findMany({ include: { variants: true } });
    const images = files.filter(f => isRaster(f.ext));
    let made = 0, skipped = 0, failed = 0;
    await pool(images, 3, async f => {
      const kinds = f.bucket === "PUBLIC" ? WIDTHS : ([400] as const);
      const have = new Set(f.variants.filter(v => existsSync(join(STORAGE_DIR, v.storageKey))).map(v => v.kind));
      if (kinds.every(w => have.has(`w${w}`)) && f.width) { skipped++; return; }
      const bucket = f.bucket === "PRIVATE" ? "private" : "public";
      try {
        const dec = await decodable(join(STORAGE_DIR, f.storageKey), f.ext);
        const meta = await open(dec).rotate().metadata();
        const portrait = (meta.orientation ?? 1) >= 5;
        await db.file.update({ where: { id: f.id }, data: { width: portrait ? meta.height : meta.width, height: portrait ? meta.width : meta.height } });
        for (const w of kinds) {
          const key = `${bucket}/v/${f.sha256.slice(0, 2)}/${f.sha256}-w${w}.webp`;
          const dest = join(STORAGE_DIR, key);
          mkdirSync(dirname(dest), { recursive: true, mode: bucket === "private" ? 0o700 : 0o755 });
          const info = await open(dec).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(dest);
          await db.fileVariant.upsert({
            where: { fileId_kind: { fileId: f.id, kind: `w${w}` } },
            update: { storageKey: key, mime: "image/webp", width: info.width, height: info.height, size: info.size },
            create: { fileId: f.id, kind: `w${w}`, storageKey: key, mime: "image/webp", width: info.width, height: info.height, size: info.size },
          });
          made++;
        }
        if (dec.jpeg) { // HEIC: keep a browser-viewable JPEG
          const key = `${bucket}/v/${f.sha256.slice(0, 2)}/${f.sha256}-jpeg.jpg`;
          writeFileSync(join(STORAGE_DIR, key), dec.jpeg, { mode: bucket === "private" ? 0o600 : 0o644 });
          await db.fileVariant.upsert({ where: { fileId_kind: { fileId: f.id, kind: "jpeg" } }, update: { storageKey: key, mime: "image/jpeg", size: dec.jpeg.length }, create: { fileId: f.id, kind: "jpeg", storageKey: key, mime: "image/jpeg", size: dec.jpeg.length } });
        }
      } catch { failed++; }
    });
    return { rasterFiles: images.length, variantsWritten: made, alreadyDone: skipped, failedToDecode: failed };
  },
};

export const fileVerifyStep: Step = {
  id: "20",
  name: "verify files: every private file and a 20% public sample re-hashed; links complete",
  async run() {
    const files = await db.file.findMany({ select: { id: true, bucket: true, sha256: true, storageKey: true } });
    const sample = files.filter(f => f.bucket === "PRIVATE" || f.id % 5 === 0);
    let ok = 0;
    const bad: number[] = [];
    await pool(sample, 4, async f => { (await sha256File(join(STORAGE_DIR, f.storageKey))) === f.sha256 ? ok++ : bad.push(f.id); });
    if (bad.length) throw new Error(`checksum mismatch for ${bad.length} files (ids ${bad.slice(0, 10).join(", ")})`);
    const unlinked = {
      covers: await db.article.count({ where: { legacyCoverPath: { not: null }, coverFileId: null } }),
      documents: await db.document.count({ where: { fileId: null } }),
      galleryImages: await db.galleryItem.count({ where: { mediaType: "IMAGE", fileId: null } }),
    };
    if (unlinked.covers || unlinked.documents) throw new Error(`unlinked covers/documents: ${JSON.stringify(unlinked)}`);
    return { checksumsVerified: ok, privateVerified: sample.filter(f => f.bucket === "PRIVATE").length, unlinkedGalleryImages: unlinked.galleryImages };
  },
};
