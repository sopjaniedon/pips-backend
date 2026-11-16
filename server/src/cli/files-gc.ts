// Storage clean-up. Dry run by default: reports what could be removed. With --apply it removes
//  1. bytes on disk that no File/FileVariant row points to (e.g. after a media item was deleted in the admin),
//  2. PUBLIC files uploaded in the admin that nothing uses any more (no article, document, gallery item, old URL
//     or link inside a text), with their variants,
//  3. temporary uploads older than a day.
// Files imported from the old site (they have legacy paths) and applicants' files that are still recorded are never
// removed here; private bytes without any database record (left by a deleted test or a failed write) are.
// Usage: pnpm --filter @pips/server files:gc [--list] [--apply]
import { readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config.js";
import { paths } from "../lib/paths.js";

const apply = process.argv.includes("--apply");
const list = process.argv.includes("--list");
const config = loadConfig();
const { storageDir } = paths(config);
const db = new PrismaClient();
const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}

// 2. Unused admin uploads (public, no legacy path, no reference anywhere)
const unused = await db.$queryRaw<{ id: number; storageKey: string; size: bigint }[]>`
  SELECT f.id, f."storageKey", f.size FROM "File" f
  WHERE f.bucket = 'PUBLIC'
    AND NOT EXISTS (SELECT 1 FROM "LegacyPath" lp WHERE lp."fileId" = f.id)
    AND NOT EXISTS (SELECT 1 FROM "Article" a WHERE a."coverFileId" = f.id)
    AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."fileId" = f.id)
    AND NOT EXISTS (SELECT 1 FROM "GalleryItem" g WHERE g."fileId" = f.id)
    AND NOT EXISTS (SELECT 1 FROM "SubmissionValue" v WHERE v."fileId" = f.id)
    AND NOT EXISTS (SELECT 1 FROM "ArticleTranslation" t WHERE t."bodyHtml" LIKE '%/files/' || f.id || '/%' OR t.summary LIKE '%/files/' || f.id || '/%')
    AND NOT EXISTS (SELECT 1 FROM "HtmlBlock" b WHERE b.html LIKE '%/files/' || f.id || '/%')
    AND f."createdAt" < now() - interval '1 day'`;
const unusedBytes = unused.reduce((n, f) => n + Number(f.size), 0);
if (apply && unused.length) {
  await db.file.deleteMany({ where: { id: { in: unused.map(f => f.id) } } }); // variants cascade; bytes go in step 1
}

// 1. Orphan bytes on disk
const known = new Set<string>();
for (const f of await db.file.findMany({ select: { storageKey: true } })) known.add(f.storageKey);
for (const v of await db.fileVariant.findMany({ select: { storageKey: true } })) known.add(v.storageKey);
let orphans = 0, orphanBytes = 0;
for (const bucket of ["public", "private"]) {
  for await (const p of walk(join(storageDir, bucket))) {
    const key = relative(storageDir, p).split("\\").join("/");
    if (known.has(key)) continue;
    const s = await stat(p);
    orphans++; orphanBytes += s.size;
    if (list) console.log(`  orphan ${key} (${s.size} bytes, ${s.mtime.toISOString().slice(0, 16)})`);
    if (apply) await rm(p);
  }
}

// 3. Stale temporary uploads
let tmp = 0;
for await (const p of walk(join(storageDir, "tmp"))) {
  if (Date.now() - (await stat(p)).mtimeMs > 24 * 3600_000) { tmp++; if (apply) await rm(p); }
}

console.log(`${apply ? "Removed" : "Would remove"}:`);
console.log(`  unused admin uploads: ${unused.length} (${mb(unusedBytes)})`);
console.log(`  files on disk without a database row: ${orphans} (${mb(orphanBytes)})${apply ? "" : " — includes the uploads above only after --apply"}`);
console.log(`  stale temporary uploads: ${tmp}`);
if (!apply) console.log("Run with --apply to remove them.");
if (apply) await db.auditLog.create({ data: { action: "files.gc", entityType: "File", meta: { unusedRows: unused.length, orphanFiles: orphans, orphanBytes, tmp } } });
await db.$disconnect();
