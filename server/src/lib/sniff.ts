// Detects a file's real type from its first bytes. Uploads are accepted by content, never by name or browser MIME.
export interface Sniffed { mime: string; ext: string }

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function sniff(head: Buffer, filename: string): Sniffed | null {
  const at = (sig: number[], off = 0) => sig.every((b, i) => head[off + i] === b);
  const ascii = (off: number, len: number) => head.subarray(off, off + len).toString("latin1");
  const name = filename.toLowerCase();
  if (ascii(0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (at([0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (ascii(0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(8, 4))) return { mime: "image/heic", ext: "heic" };
  // Word: .docx is a zip (only accepted with a .docx name), .doc is an OLE compound file.
  if (at([0x50, 0x4b, 0x03, 0x04]) && name.endsWith(".docx")) return { mime: DOCX, ext: "docx" };
  if (at([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && name.endsWith(".doc")) return { mime: "application/msword", ext: "doc" };
  // Other Office files are only accepted in the admin (documents attached to articles).
  if (at([0x50, 0x4b, 0x03, 0x04]) && name.endsWith(".xlsx")) return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
  if (at([0x50, 0x4b, 0x03, 0x04]) && name.endsWith(".pptx")) return { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
  if (at([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && name.endsWith(".xls")) return { mime: "application/vnd.ms-excel", ext: "xls" };
  if (at([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && name.endsWith(".ppt")) return { mime: "application/vnd.ms-powerpoint", ext: "ppt" };
  return null;
}

/** DigForm's FP_FileExtension is a comma list of MIME types, possibly with wildcards ("image/*"). */
export function accepts(accept: string | null | undefined, mime: string): boolean {
  if (!accept) return true;
  return accept.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).some(a => a === mime || (a.endsWith("/*") && mime.startsWith(a.slice(0, -1))));
}
