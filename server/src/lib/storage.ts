// Content-addressed file storage (same layout as the migration): {bucket}/{sha[0:2]}/{sha}.{ext}.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import type { Bucket, PrismaClient } from "@prisma/client";

export interface Spooled { tmpPath: string; sha256: string; size: number; head: Buffer }

/** Streams an upload to a temp file, hashing it and keeping the first bytes for type sniffing. */
export async function spool(storageDir: string, input: Readable): Promise<Spooled> {
  const tmpDir = join(storageDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, randomUUID());
  const hash = createHash("sha256");
  let size = 0;
  const chunks: Buffer[] = [];
  let headLen = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk); size += chunk.length;
      if (headLen < 64) { chunks.push(chunk.subarray(0, 64 - headLen)); headLen += Math.min(chunk.length, 64 - headLen); }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(input, tap, createWriteStream(tmpPath, { mode: 0o600 }));
  } catch (e) {
    await rm(tmpPath, { force: true });
    throw e;
  }
  return { tmpPath, sha256: hash.digest("hex"), size, head: Buffer.concat(chunks) };
}

/** Moves a spooled file into the bucket (deduplicated by hash) and returns its File row. */
export async function commitFile(db: PrismaClient, storageDir: string, s: Spooled, meta: { bucket: Bucket; mime: string; ext: string; originalName: string }) {
  const existing = await db.file.findUnique({ where: { bucket_sha256: { bucket: meta.bucket, sha256: s.sha256 } } });
  if (existing) { await rm(s.tmpPath, { force: true }); return existing; }
  const storageKey = `${meta.bucket.toLowerCase()}/${s.sha256.slice(0, 2)}/${s.sha256}.${meta.ext}`;
  const dest = join(storageDir, storageKey);
  await mkdir(dirname(dest), { recursive: true });
  const already = await stat(dest).then(() => true, () => false);
  if (already) await rm(s.tmpPath, { force: true }); else await rename(s.tmpPath, dest);
  try {
    return await db.file.create({ data: { bucket: meta.bucket, sha256: s.sha256, size: BigInt(s.size), mime: meta.mime, ext: meta.ext, originalName: meta.originalName, storageKey } });
  } catch (e) {
    // Another request stored the same content at the same moment.
    const again = await db.file.findUnique({ where: { bucket_sha256: { bucket: meta.bucket, sha256: s.sha256 } } });
    if (again) return again;
    throw e;
  }
}

export const discard = (s: Spooled) => rm(s.tmpPath, { force: true });

/** Keeps the base name only, NFC, without control characters, at most 180 characters. */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.normalize("NFC").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "file").slice(-180);
}
