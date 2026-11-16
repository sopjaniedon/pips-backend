// Re-creates every legacy DNN URL from the imported registry and checks it lands on a working page in one hop.
// Usage (server running): pnpm --filter @pips/server exec tsx --env-file=../.env src/cli/check-redirects.ts [baseUrl]
import { PrismaClient } from "@prisma/client";

const base = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const db = new PrismaClient();
const hy = (s: string) => s.trim().replace(/\s+/g, "-");

const pages = await db.pageMeta.findMany({ where: { legacyTabId: { not: null } } });
const tab = new Map(pages.map(p => [p.legacyTabId!, p]));
const urls: { url: string; kind: string; expectGone?: boolean }[] = [];

for (const u of await db.legacyUrl.findMany()) {
  const p = tab.get(u.tabId);
  if (!p) continue;
  const prefix = `/${p.lang === "en" ? "en" : "sq"}/${hy(p.legacyName ?? p.title)}`;
  if (u.linkType === 0 && u.articleId) urls.push({ url: `${prefix}/ArtMID/${u.moduleId}/ArticleID/${u.articleId}/${u.slug}`, kind: "article" });
  else if (u.linkType === 1 && u.categoryId) urls.push({ url: `${prefix}/PID/${u.moduleId}/CategoryID/${u.categoryId}/CategoryName/${u.slug}`, kind: "category" });
  else if (u.linkType === 2 && u.authorId) urls.push({ url: `${prefix}/PID/${u.moduleId}/AuthorID/${u.authorId}/AuthorName/${u.slug}`, kind: "author" });
  else if (u.linkType === 8) urls.push({ url: `${prefix}/ctl/rss/mid/${u.moduleId}`, kind: "rss" });
}
for (const r of await db.redirect.findMany()) urls.push({ url: r.fromPath, kind: "page" });
for (const d of await db.document.findMany({ select: { legacyId: true } })) urls.push({ url: `/DesktopModules/EasyDNNNews/DocumentDownload.ashx?portalid=0&moduleid=1446&documentid=${d.legacyId}`, kind: "document" });
for (const lp of await db.legacyPath.findMany({ where: { found: true }, take: 400, orderBy: { path: "asc" } }))
  urls.push({ url: encodeURI(lp.originalPath), kind: lp.path.startsWith("/portals/0/digform/") ? "applicant-file" : "file", expectGone: lp.path.startsWith("/portals/0/digform/") });

const results: Record<string, { ok: number; fail: number; examples: string[] }> = {};
const unpublished = new Set((await db.article.findMany({ where: { status: { not: "PUBLISHED" } }, select: { legacyId: true } })).map(a => String(a.legacyId)));
let i = 0;
async function check(u: (typeof urls)[number]) {
  const r = (results[u.kind] ??= { ok: 0, fail: 0, examples: [] });
  try {
    const first = await fetch(base + u.url, { redirect: "manual", headers: { "user-agent": "redirect-check-bot" } });
    let ok: boolean;
    if (u.expectGone) ok = first.status === 410;
    else if (first.status !== 301 && first.status !== 302) ok = false;
    else {
      const loc = first.headers.get("location") ?? "";
      if (/^https?:/i.test(loc) && !loc.startsWith(base)) { r.ok++; return; } // DNN "Link" item → its external site
      if (u.url.toLowerCase().includes("/alumni") && loc === "/alumni") { r.ok++; return; } // staff-only page, as in DNN
      const second = await fetch(new URL(loc, base), { redirect: "manual", method: u.kind === "document" || u.kind === "file" ? "HEAD" : "GET", headers: { "user-agent": "redirect-check-bot" } });
      ok = second.status === 200;
      // An article that is not published in DNN either may 404: count it as expected.
      if (!ok && u.kind === "article" && second.status === 404 && unpublished.has(/ArticleID\/(\d+)/.exec(u.url)?.[1] ?? "")) ok = true;
    }
    if (ok) r.ok++; else { r.fail++; if (r.examples.length < 5) r.examples.push(`${u.url} → ${first.status} ${first.headers.get("location") ?? ""}`); }
  } catch (e) { r.fail++; if (r.examples.length < 5) r.examples.push(`${u.url} → ${String(e)}`); }
}
await Promise.all(Array.from({ length: 8 }, async () => { while (i < urls.length) await check(urls[i++]); }));
console.log(JSON.stringify({ base, total: urls.length, results }, null, 2));
await db.$disconnect();
process.exitCode = Object.values(results).some(r => r.fail) ? 1 : 0;
