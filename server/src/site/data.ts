// Builds window.PIPS_DATA for the public pages from PostgreSQL, in the shapes the prototype's page scripts use.
// Content model = DNN's: articles in categories (legacy ids below), programs and year as article fields.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { articlePath, type Lang } from "./routes.js";

export const CAT = {
  activities: 5, publications: 6, pipsEngages: 7, team: 8, board: 9, donors: [10, 22], partners: 17,
  sopAbout: 11, worldForum: 13, alumni: 14, network: 16, programIntros: [18, 19, 20, 21],
} as const;

const MONTHS: Record<Lang, string[]> = {
  sq: ["jan", "shk", "mar", "pri", "maj", "qer", "kor", "gus", "sht", "tet", "nën", "dhj"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};
export const fmtDate = (d: Date, lang: Lang) => `${d.getUTCDate()} ${MONTHS[lang][d.getUTCMonth()]} ${d.getUTCFullYear()}`;

const fileUrl = (f: { id: number; originalName: string } | null | undefined, kind?: string) =>
  !f ? null : kind ? `/files/${f.id}/v/${kind}/${encodeURIComponent(f.originalName.replace(/\.[^.]+$/, ""))}.webp` : `/files/${f.id}/${encodeURIComponent(f.originalName)}`;
const img = (f: { id: number; originalName: string; variants?: { kind: string }[] } | null | undefined, kind: "w400" | "w800" | "w1600") =>
  !f ? null : f.variants?.some(v => v.kind === kind) ? fileUrl(f, kind) : fileUrl(f);
const text = (html: string | null | undefined) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const excerpt = (s: string, n = 260) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
/** YouTube watch/short/embed URL → privacy-enhanced embed URL; other providers are dropped. */
function youtubeEmbed(u: string): string | null {
  const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:.*&)?v=|v\/))([A-Za-z0-9_-]{11})/.exec(u);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
}
export const docUrl = (d: { id: number; fileName: string }) => `/docs/${d.id}/${encodeURIComponent(d.fileName.replace(/\.resources$/i, ""))}`;

const articleInclude = {
  translations: true,
  categories: { include: { category: { select: { legacyId: true } } } },
  programs: { include: { program: { include: { translations: true } } } },
  cover: { include: { variants: { select: { kind: true } } } },
  documents: { include: { document: true }, orderBy: { position: "asc" } },
} satisfies Prisma.ArticleInclude;
type ArticleRow = Prisma.ArticleGetPayload<{ include: typeof articleInclude }>;

const liveWhere = (now: Date): Prisma.ArticleWhereInput => ({
  status: "PUBLISHED", deletedAt: null, publishAt: { lte: now }, OR: [{ expireAt: null }, { expireAt: { gt: now } }],
});

/** EN falls back to the Albanian text when untranslated (as DNN did), unless the article hides its default locale. */
export function pickTranslation(a: { translations: ArticleRow["translations"]; hideDefaultLocale: boolean }, lang: Lang) {
  const own = a.translations.find(t => t.lang === lang);
  if (own) return { t: own, fallback: false };
  if (lang === "en" && a.hideDefaultLocale) return null;
  const sq = a.translations.find(t => t.lang === "sq");
  return sq ? { t: sq, fallback: lang !== "sq" } : null;
}

const progName = (p: { translations: { lang: string; name: string }[] }, lang: Lang) =>
  p.translations.find(t => t.lang === lang)?.name ?? p.translations.find(t => t.lang === "sq")?.name ?? "";

function href(a: ArticleRow, kind: "activity" | "publication", lang: Lang, slug: string): string | null {
  if (a.detailType === "LINK") return a.linkUrl;
  if (a.detailType === "NONE") return null;
  return articlePath(kind, lang, a.id, slug);
}

function activityDto(a: ArticleRow, lang: Lang) {
  const tr = pickTranslation(a, lang);
  if (!tr) return null;
  const progs = a.programs.map(p => p.program);
  const summary = text(tr.t.summary) || excerpt(tr.t.bodyText);
  return {
    id: String(a.id), href: href(a, "activity", lang, tr.t.slug), external: a.detailType === "LINK",
    title: tr.t.title, fallbackLang: tr.fallback ? "sq" : null,
    category: progs[0] ? progName(progs[0], lang) : lang === "en" ? "Activity" : "Aktivitet",
    program: progs[0]?.key ?? null, programs: progs.map(p => p.key),
    date: fmtDate(a.publishAt, lang), iso: a.publishAt.toISOString().slice(0, 10), year: a.publicationYear ?? a.publishAt.getUTCFullYear(),
    location: null, excerpt: excerpt(summary), image: a.showCover ? img(a.cover, "w1600") : null, thumb: img(a.cover, "w800"),
    featured: a.featured, views: a.viewCount, donors: [] as string[], url: null,
  };
}

function publicationDto(a: ArticleRow, lang: Lang) {
  const tr = pickTranslation(a, lang);
  if (!tr) return null;
  const progs = a.programs.map(p => progName(p.program, lang));
  const docs = a.documents.map(d => d.document).filter(d => d.visible && d.fileId);
  return {
    id: String(a.id), href: href(a, "publication", lang, tr.t.slug), external: a.detailType === "LINK",
    title: tr.t.title, fallbackLang: tr.fallback ? "sq" : null,
    kind: a.analyticalType ?? (lang === "en" ? "Publication" : "Publikim"), analytical: !!a.analyticalType,
    topic: progs[0] ?? (lang === "en" ? "General" : "Të përgjithshme"), topics: progs, programs: a.programs.map(p => p.program.key),
    authors: [] as string[], year: a.publicationYear ?? a.publishAt.getUTCFullYear(),
    date: fmtDate(a.publishAt, lang), iso: a.publishAt.toISOString().slice(0, 10),
    summary: excerpt(text(tr.t.summary) || tr.t.bodyText, 420), cover: img(a.cover, "w800"),
    pdf: docs[0] ? docUrl(docs[0]) : null, documentCount: docs.length, views: a.viewCount,
  };
}

function personDto(a: ArticleRow, lang: Lang) {
  const tr = pickTranslation(a, lang);
  if (!tr) return null;
  return { id: String(a.id), name: tr.t.title, role: tr.t.subtitle ?? "", org: null, photo: img(a.cover, "w400"), bio: excerpt(text(tr.t.summary) || tr.t.bodyText, 500) || null, email: null, linkedin: null };
}

function donorDto(a: ArticleRow, lang: Lang, current = true) {
  const tr = pickTranslation(a, lang);
  if (!tr) return null;
  return { id: String(a.id), name: tr.t.title, short: tr.t.title, url: a.linkUrl ?? "#", logo: img(a.cover, "w400"), current };
}

/** Static collections with no DNN backend (generation lists, programme texts, SOP facts): kept from the prototype data. */
let staticData: Record<string, unknown> | null = null;
function loadStatic(webDir: string): Record<string, unknown> {
  if (staticData) return staticData;
  const ctx: { window: { PIPS_DATA?: Record<string, unknown> } } = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(webDir, "assets/js/data.js"), "utf8"), ctx);
  const d = ctx.window.PIPS_DATA ?? {};
  staticData = { generations: d.generations, sop: d.sop, about: d.about, contact: d.contact, staticPrograms: d.programs };
  return staticData;
}

export interface SiteData { data: Record<string, unknown>; byId: Map<number, ArticleRow> }
const cache = new Map<Lang, { at: number; value: SiteData }>();
const TTL_MS = 30_000;

export function invalidateSiteData() { cache.clear(); }

export async function siteData(db: PrismaClient, lang: Lang, webDir: string): Promise<SiteData> {
  const hit = cache.get(lang);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const rows = await db.article.findMany({ where: liveWhere(new Date()), include: articleInclude, orderBy: { publishAt: "desc" } });
  const inCat = (a: ArticleRow, ids: readonly number[]) => a.categories.some(c => ids.includes(c.category.legacyId ?? -1));
  const pick = <T>(ids: readonly number[], fn: (a: ArticleRow) => T | null) => rows.filter(a => inCat(a, ids)).map(fn).filter((x): x is T => x !== null);

  const publications = pick([CAT.publications], a => publicationDto(a, lang));
  const programs = await db.program.findMany({ include: { translations: true }, orderBy: { position: "asc" } });
  const intros = rows.filter(a => inCat(a, [...CAT.programIntros, CAT.sopAbout]));
  const programDtos = programs.map(p => {
    const name = progName(p, lang);
    const sqName = progName(p, "sq").toLowerCase();
    const intro = intros.find(a => {
      const t = a.translations.find(x => x.lang === "sq")?.title.toLowerCase() ?? "";
      return t && (sqName.startsWith(t.split(" ")[0]) || t.startsWith(sqName.split(" ")[0]));
    });
    const tr = intro ? pickTranslation(intro, lang) : null;
    return { key: p.key, name, since: null, summary: tr ? excerpt(text(tr.t.summary) || tr.t.bodyText, 600) : "" };
  });

  const s = loadStatic(webDir);
  const data = {
    lang,
    activities: pick([CAT.activities], a => activityDto(a, lang)),
    publications,
    research: publications.filter(p => p.analytical),
    staff: pick([CAT.team], a => personDto(a, lang)),
    board: pick([CAT.board], a => personDto(a, lang)),
    associates: [],
    donors: [...pick(CAT.donors, a => donorDto(a, lang)), ...pick([CAT.partners], a => donorDto(a, lang, true))]
      .filter((d, i, arr) => arr.findIndex(x => x.name === d.name) === i),
    testimonials: pick([CAT.alumni], a => { const p = personDto(a, lang); return p ? { name: p.name, role: p.role, quote: p.bio ?? "", photo: p.photo } : null; }),
    pipsEngages: pick([CAT.pipsEngages], a => activityDto(a, lang)),
    programs: programDtos,
    generations: s.generations, sop: s.sop, about: s.about, contact: s.contact,
    years: [...new Set(rows.map(a => a.publicationYear ?? a.publishAt.getUTCFullYear()))].sort((x, y) => y - x),
  };
  const value = { data, byId: new Map(rows.map(r => [r.id, r])) };
  cache.set(lang, { at: Date.now(), value });
  return value;
}

/** Detail payload for one article (body, gallery, documents). Not cached: also used for view counting. */
export async function articleDetail(db: PrismaClient, id: number, lang: Lang) {
  const a = await db.article.findFirst({
    where: { id, ...liveWhere(new Date()) },
    include: {
      ...articleInclude,
      gallery: { where: { visible: true }, orderBy: { position: "asc" }, include: { file: { include: { variants: { select: { kind: true } } } } } },
    },
  });
  if (!a) return null;
  const tr = pickTranslation(a, lang);
  if (!tr) return null;
  const isActivity = a.categories.some(c => c.category.legacyId === CAT.activities);
  return {
    article: a, tr: tr.t, fallback: tr.fallback, kind: (isActivity ? "activity" : "publication") as "activity" | "publication",
    item: {
      id: String(a.id), title: tr.t.title, subtitle: tr.t.subtitle, bodyHtml: tr.t.bodyHtml, summaryHtml: tr.t.summary,
      fallbackLang: tr.fallback ? "sq" : null, type: a.analyticalType ? "research" : "publication",
      gallery: a.gallery.filter(g => g.mediaType === "IMAGE" && g.file).map(g => img(g.file, "w1600")),
      galleryThumbs: a.gallery.filter(g => g.mediaType === "IMAGE" && g.file).map(g => img(g.file, "w400")),
      videos: a.gallery.filter(g => g.mediaType === "VIDEO" && g.embedUrl).map(g => youtubeEmbed(g.embedUrl!)).filter(Boolean),
      documents: a.documents.map(d => d.document).filter(d => d.visible && d.fileId).map(d => ({ id: d.id, title: d.title ?? d.fileName, url: docUrl(d), ext: d.extension, size: Number(d.size) })),
      pdfInline: (() => { const d = a.documents.map(x => x.document).find(x => x.visible && x.fileId && x.extension === "pdf"); return d ? `${docUrl(d)}?inline=1` : null; })(),
    },
  };
}

type Item = { id: string; featured?: boolean; kind?: string; title?: string };
const BIG = ["activities", "publications", "research"] as const;
/**
 * The part of the site data a page template uses. List pages get the full lists; other pages get only the few
 * items they show (the header search asks the API instead), which keeps every page small.
 */
export function dataFor(template: string, data: Record<string, unknown>, currentId?: number): Record<string, unknown> {
  const lists = Object.fromEntries(BIG.map(k => [k, (data[k] ?? []) as Item[]])) as Record<(typeof BIG)[number], Item[]>;
  const keep = (arr: Item[], n: number, extra: (x: Item) => boolean = () => false) => arr.filter((x, i) => i < n || extra(x) || (currentId != null && x.id === String(currentId)));
  let pick: Partial<Record<(typeof BIG)[number], Item[]>>;
  switch (template) {
    case "activities.html": case "publications.html": case "research.html": case "news.html": case "programs.html": case "design-system.html":
      return data;
    case "index.html": pick = { activities: keep(lists.activities, 12, x => !!x.featured), publications: keep(lists.publications, 6), research: keep(lists.research, 6) }; break;
    case "activity.html": pick = { activities: keep(lists.activities, 40) }; break;
    case "item.html": pick = { publications: keep(lists.publications, 20), research: keep(lists.research, 20) }; break;
    case "school-of-politics.html": pick = { activities: keep(lists.activities, 6, x => /strasbourg|strasburg|world forum|forumi bot/i.test(x.title ?? "")) }; break;
    case "strategy.html": pick = { publications: lists.publications.filter(x => x.kind === "Strategy" || /strateg/i.test(x.title ?? "")) }; break;
    default: pick = {};
  }
  const out: Record<string, unknown> = { ...data };
  for (const k of BIG) out[k] = pick[k] ?? [];
  return out;
}
