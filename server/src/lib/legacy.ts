// Path normalisation shared with the migration (migration/src/lib/files.ts legacyKey, migration/src/lib/text.ts normPath).

/** "/portals/0/…" key: NFC, lower-case, URL-decoded, no ".resources" suffix. */
export function legacyKey(p: string): string {
  let s = p.trim();
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.replace(/\\/g, "/").replace(/^https?:\/\/(www\.)?pips-ks\.org/i, "");
  if (!s.startsWith("/")) s = "/" + s;
  return s.normalize("NFC").toLowerCase().replace(/\/{2,}/g, "/").replace(/\.resources$/, "");
}

/** Redirect-table key: NFC, lower-case, no trailing slash, no query. */
export function normPath(p: string): string {
  let s = p.split("?")[0];
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.normalize("NFC").toLowerCase().replace(/\/+/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s.startsWith("/") ? s : "/" + s;
}

export const BOT_UA = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|curl|wget|python-requests|httpclient/i;
