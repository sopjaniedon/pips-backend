// Spot check against the live DNN site (read-only). The live site refuses scripts (HTTP 403 for non-browser
// clients), so the pages are read in a normal browser tab with scripts/spot-check-browser.js; this tool makes the
// sample and compares the results.
//   1. pnpm --filter @pips/server exec tsx --env-file=../.env src/cli/spot-check.ts sample [--n 50] [--docs 20]
//        -> data/reports/spot-sample.json (legacy URLs + what our database says)
//   2. In a browser tab on https://pips-ks.org, run scripts/spot-check-browser.js with that sample
//        -> save its output as data/reports/spot-live.json
//   3. ... spot-check.ts compare  -> data/reports/spot-check.md, exit code 1 on any mismatch
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../config.js";
import { paths } from "../lib/paths.js";

const config = loadConfig();
const dir = join(paths(config).repoRoot, "data/reports");
mkdirSync(dir, { recursive: true });
const db = new PrismaClient();
const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const hy = (s: string) => s.trim().replace(/\s+/g, "-");

interface SampleArticle { kind: "article"; lang: "sq" | "en"; id: number; legacyId: number; url: string; title: string; date: string; gallery: number | null; docs: number; programs: string[]; year: number | null; body: string }
interface SampleDoc { kind: "document"; id: number; legacyId: number; url: string; sha256: string; size: number }

async function sample() {
  const n = arg("n", 50), nd = arg("docs", 20);
  const pages = new Map((await db.pageMeta.findMany({ where: { legacyTabId: { not: null } } })).map(p => [p.legacyTabId!, p]));
  const urls = await db.legacyUrl.findMany({ where: { linkType: 0 } });
  const now = new Date();
  const arts = await db.article.findMany({
    where: { legacyId: { not: null }, deletedAt: null, status: "PUBLISHED", detailType: "TEXT", publishAt: { lte: now }, OR: [{ expireAt: null }, { expireAt: { gt: now } }] },
    include: { translations: true, programs: { include: { program: { include: { translations: true } } } }, documents: { include: { document: true } }, gallery: true },
  });
  const shuffle = <T>(a: T[]) => a.map(x => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map(x => x[1]);
  const out: (SampleArticle | SampleDoc)[] = [];
  for (const lang of ["sq", "en"] as const) {
    const pool = shuffle(arts.filter(a => a.translations.some(t => t.lang === lang)));
    let taken = 0;
    for (const a of pool) {
      if (taken >= n) break;
      // Prefer the main detail module (1444): the second one (1468) renders with another template.
      const u = urls.find(x => x.articleId === a.legacyId && x.moduleId === 1444 && pages.get(x.tabId)?.lang === lang && /^(Detajet|Details)$/i.test(pages.get(x.tabId)?.legacyName ?? ""))
        ?? urls.find(x => x.articleId === a.legacyId && pages.get(x.tabId)?.lang === lang && /^(Detajet|Details)$/i.test(pages.get(x.tabId)?.legacyName ?? ""))
        ?? urls.find(x => x.articleId === a.legacyId && pages.get(x.tabId)?.lang === lang);
      if (!u) continue;
      const p = pages.get(u.tabId)!;
      const t = a.translations.find(x => x.lang === lang)!;
      out.push({
        kind: "article", lang, id: a.id, legacyId: a.legacyId!, url: `/${lang}/${hy(p.legacyName ?? p.title)}/ArtMID/${u.moduleId}/ArticleID/${a.legacyId}/${u.slug}`,
        title: t.title, date: a.publishAt.toISOString(),
        gallery: a.showGallery ? a.gallery.filter(g => g.visible && !g.isCoverCopy && g.mediaType === "IMAGE").length : null,
        docs: a.documents.filter(d => d.document.visible).length,
        programs: a.programs.map(p2 => p2.program.translations.find(x => x.lang === lang)?.name ?? p2.program.translations.find(x => x.lang === "sq")?.name ?? p2.program.key),
        year: a.publicationYear, body: t.bodyText,
      });
      taken++;
    }
  }
  const docs = shuffle(await db.document.findMany({ where: { legacyId: { not: null }, file: { isNot: null }, size: { lte: 10 * 1048576 } }, include: { file: true } })).slice(0, nd);
  for (const d of docs) out.push({ kind: "document", id: d.id, legacyId: d.legacyId!, url: `/DesktopModules/EasyDNNNews/DocumentDownload.ashx?portalid=0&moduleid=1446&documentid=${d.legacyId}`, sha256: d.file!.sha256, size: Number(d.file!.size) });
  writeFileSync(join(dir, "spot-sample.json"), JSON.stringify(out, null, 1));
  console.log(`Sample: ${out.filter(x => x.kind === "article").length} articles, ${docs.length} documents → data/reports/spot-sample.json`);
  // Only the URLs go to the browser script.
  writeFileSync(join(dir, "spot-urls.json"), JSON.stringify(out.map(x => ({ kind: x.kind, url: x.url }))));
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[“”„"'’‘`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function dice(a: string, b: string) {
  const grams = (s: string) => { const w = norm(s).split(" ").filter(Boolean); const m = new Map<string, number>(); for (let i = 0; i < w.length - 1; i++) { const g = w[i] + " " + w[i + 1]; m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0, total = 0;
  for (const [g, c] of A) { inter += Math.min(c, B.get(g) ?? 0); total += c; }
  for (const c of B.values()) total += c;
  return (2 * inter) / total;
}

interface Live { url: string; status: number; title?: string; date?: string; gallery?: number; docs?: number; fields?: string; body?: string; bodyCut?: number; sha256?: string; size?: number }

async function compare() {
  const sampleData = JSON.parse(readFileSync(join(dir, "spot-sample.json"), "utf8")) as (SampleArticle | SampleDoc)[];
  const live = new Map((JSON.parse(readFileSync(join(dir, "spot-live.json"), "utf8")) as Live[]).map(l => [l.url, l]));
  const rows: string[] = [];
  let fail = 0;
  // DNN shows "1 Aug 2018" on English pages and Albanian abbreviations ("1 Gush 2018", "30 Nën 2019") on Albanian ones.
  const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    shk: 1, pri: 3, maj: 4, qer: 5, kor: 6, gus: 7, sht: 8, tet: 9, "nën": 10, dhj: 11 };
  for (const s of sampleData) {
    const l = live.get(s.url);
    const problems: string[] = [];
    if (!l || l.status !== 200) problems.push(`live ${l ? l.status : "not read"}`);
    else if (s.kind === "document") {
      if (l.sha256 !== s.sha256) problems.push(`bytes differ (live ${l.size} B, here ${s.size} B)`);
    } else {
      if (norm(l.title ?? "") !== norm(s.title)) problems.push(`title “${l.title}” ≠ “${s.title}”`);
      const m = /(\d{1,2})\s+(\p{L}{3})\p{L}*\s+(\d{4})/u.exec(l.date ?? "");
      if (m && m[2].toLowerCase() in MON) {
        const liveDay = Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]);
        const ours = new Date(s.date); const ourDay = Date.UTC(ours.getUTCFullYear(), ours.getUTCMonth(), ours.getUTCDate());
        if (Math.abs(liveDay - ourDay) > 86400000) problems.push(`date ${l.date} ≠ ${s.date.slice(0, 10)}`); // DNN shows Kosovo time
      } else if (l.date) problems.push(`unreadable live date “${l.date}”`); // some DNN pages show no date at all
      if (s.gallery != null && l.gallery != null && l.gallery !== s.gallery) problems.push(`gallery ${l.gallery} ≠ ${s.gallery}`);
      if (l.docs != null && l.docs !== s.docs) problems.push(`documents ${l.docs} ≠ ${s.docs}`);
      for (const p of s.programs) if (!norm(l.fields ?? "").includes(norm(p))) problems.push(`program “${p}” not on the live page`);
      if (s.year && !(l.fields ?? "").includes(String(s.year))) problems.push(`year ${s.year} not on the live page`);
      // The browser reading may keep only the start of the text (bodyCut characters): compare the same span.
      const ours = l.bodyCut ? s.body.replace(/\s+/g, " ").trim().slice(0, l.bodyCut) : s.body;
      // DNN lists the documents inside the text block; that list is compared separately (document count).
      const liveBody = (l.body ?? "").split(/\s(?:Dokumente\(t\)|Documents to download)\s/)[0];
      const sim = dice(liveBody, ours);
      if (sim < 0.95) problems.push(`text similarity ${sim.toFixed(3)}`);
    }
    if (problems.length) fail++;
    rows.push(`| ${s.kind === "article" ? `${s.lang} article #${s.id} (DNN ${s.legacyId})` : `document #${s.id} (DNN ${s.legacyId})`} | ${problems.length ? "✗ " + problems.join("; ") : "✓"} |`);
  }
  const md = `# Spot check against the live site\n\n${new Date().toISOString()}\n\n${sampleData.length - fail} of ${sampleData.length} match.\n\n| Item | Result |\n|---|---|\n${rows.join("\n")}\n`;
  writeFileSync(join(dir, "spot-check.md"), md);
  console.log(`${sampleData.length - fail} of ${sampleData.length} match → data/reports/spot-check.md`);
  process.exitCode = fail ? 1 : 0;
}

if (process.argv[2] === "sample") await sample();
else if (process.argv[2] === "compare") await compare();
else console.log("Usage: spot-check.ts sample [--n 50] [--docs 20] | compare");
await db.$disconnect();
