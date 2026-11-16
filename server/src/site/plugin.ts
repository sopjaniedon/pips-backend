// Public website: pages, article detail, files, documents, search, RSS, sitemap and legacy (DNN) URL handling.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { Prisma } from "@prisma/client";
import { PAGES, matchPath, pagePath, prettyFromFile, articlePath, type Lang } from "./routes.js";
import { siteData, articleDetail, docUrl, fmtDate, CAT, dataFor } from "./data.js";
import { publicCsp, renderPage, template } from "./render.js";
import { randomBytes } from "node:crypto";
import { clientScript, translateHtml } from "./i18n.js";
import { BOT_UA, legacyKey, normPath } from "../lib/legacy.js";
import { pageForms } from "../forms/plugin.js";
import { paths } from "../lib/paths.js";
import { COOKIE, loadSession } from "../auth/session.js";
import type { Permission } from "../auth/permissions.js";

const isBot = (req: FastifyRequest) => BOT_UA.test(req.headers["user-agent"] ?? "");
const textOf = (html: string | null | undefined) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export async function sitePlugin(app: FastifyInstance) {
  const { config, db } = app;
  const { webDir, storageDir } = paths(config);
  const dev = config.NODE_ENV !== "production";

  // Static assets of the site and the admin SPA. Page templates (*.html at the root) are only served through routes.
  await app.register(fastifyStatic, {
    root: webDir, prefix: "/", index: false, wildcard: true, decorateReply: true,
    // Only filter requests for the web folder itself; reply.sendFile() from the storage folder is checked by our routes.
    allowedPath: (p, root) => root !== webDir || p.startsWith("/assets/") || p.startsWith("/admin/") || p === "/favicon.ico" || (dev && p === "/design-system.html"),
    setHeaders: res => res.setHeader("Cache-Control", dev ? "no-cache" : "public, max-age=3600"),
  });

  const settings = async () => {
    const rows = await db.setting.findMany({ where: { key: { in: ["site.name", "site.description", "analytics.headHtml"] } } });
    const get = (k: string) => rows.find(r => r.key === k)?.value as unknown;
    return {
      name: (get("site.name") as Record<string, string> | undefined) ?? {},
      description: (get("site.description") as Record<string, string | null> | undefined) ?? {},
      headHtml: (get("analytics.headHtml") as string | null) ?? null,
    };
  };

  // Templates are English; sq pages get the translated copy (cached outside development).
  const translated = new Map<string, string>();
  function pageTemplate(tpl: string, lang: Lang) {
    const html = template(webDir, tpl, dev);
    if (lang !== "sq") return html;
    if (dev || !translated.has(tpl)) translated.set(tpl, translateHtml(html, webDir, dev));
    return translated.get(tpl)!;
  }

  async function sendPage(reply: FastifyReply, tpl: string, lang: Lang, opts: { title: string; description?: string | null; canonical: string; alternates: Partial<Record<Lang, string>>; ogImage?: string | null; ogType?: "website" | "article"; page: Record<string, unknown> }) {
    const [{ data: all }, s] = await Promise.all([siteData(db, lang, webDir), settings()]);
    const data = dataFor(tpl, all, typeof opts.page.id === "number" ? opts.page.id : Number(opts.page.id) || undefined);
    const nonce = randomBytes(16).toString("base64");
    reply.header("Content-Security-Policy", publicCsp(nonce, config.PUBLIC_BASE_URL.startsWith("https:")));
    const html = renderPage(pageTemplate(tpl, lang), {
      nonce,
      lang, bodyScript: lang === "sq" ? clientScript(webDir, dev) : null, baseUrl: config.PUBLIC_BASE_URL, headHtml: s.headHtml, data,
      title: opts.title, description: opts.description ?? s.description[lang] ?? s.description.sq ?? null,
      canonical: opts.canonical, alternates: opts.alternates, ogImage: opts.ogImage, ogType: opts.ogType, page: { ...opts.page, alternates: opts.alternates },
    });
    if (!reply.getHeader("cache-control")) reply.header("Cache-Control", "no-cache");
    return reply.type("text/html; charset=utf-8").send(html);
  }

  // ─── CSP violation reports (logged; nothing stored) ───
  for (const type of ["application/csp-report", "application/reports+json"]) {
    app.addContentTypeParser(type, { parseAs: "string", bodyLimit: 20_000 }, (_req, body, done) => { try { done(null, JSON.parse(String(body))); } catch { done(null, {}); } });
  }
  app.post("/csp-report", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const r = ((req.body as Record<string, unknown>)?.["csp-report"] ?? req.body) as Record<string, unknown>;
    req.log.warn({ csp: { page: r["document-uri"], directive: r["violated-directive"] ?? r["effective-directive"], blocked: r["blocked-uri"], line: r["line-number"] } }, "csp violation");
    return reply.code(204).send();
  });

  // ─── Admin app (static files; all data comes from /api/admin with the session cookie) ───
  const ADMIN_CSP = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:", "connect-src 'self'", "frame-src 'self' https://www.youtube-nocookie.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  const sendAdmin = (_req: FastifyRequest, reply: FastifyReply) => reply.header("Cache-Control", "no-store").header("Content-Security-Policy", ADMIN_CSP).header("X-Robots-Tag", "noindex, nofollow").sendFile("/admin/index.html", webDir, { cacheControl: false });
  app.get("/admin", (_req, reply) => reply.redirect("/admin/", 301));
  app.get("/admin/", sendAdmin);
  app.get("/admin/index.html", sendAdmin);

  // ─── Pages ───
  for (const p of PAGES) {
    for (const lang of ["sq", "en"] as const) {
      const path = lang === "en" ? p.en : p.sq;
      if (!path) continue;
      app.get(path, async (req, reply) => {
        if (p.requiredPermission) {
          // Alumni was restricted to Editors in DNN: staff signed in to the admin with the permission see it.
          const s = await loadSession(db, req.cookies[COOKIE]);
          if (!s?.perms.has(p.requiredPermission as Permission)) {
            const next = encodeURIComponent(path);
            reply.header("Cache-Control", "no-store");
            return reply.code(s ? 403 : 401).type("text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>PIPS</title><body style="font-family:system-ui;padding:48px"><h1>Kjo faqe kërkon hyrje</h1><p>Faqja e alumnive është e dukshme vetëm për stafin e PIPS.</p><p>${s ? "Llogaria juaj nuk ka qasje në këtë faqe." : `<a href="/admin/#/login?next=${next}">Hyni si staf</a>`} · <a href="/">Ballina</a></p></body>`);
          }
          reply.header("Cache-Control", "private, no-store");
        }
        const meta = await db.pageMeta.findUnique({ where: { routeKey_lang: { routeKey: p.key, lang } } });
        const s = await settings();
        const site = s.name[lang] ?? s.name.sq ?? "PIPS";
        return sendPage(reply, p.template, lang, {
          title: (() => { const t = meta?.title ?? p.title?.[lang]; return t && p.key !== "home" ? (/PIPS/.test(t) ? t : `${t} — PIPS`) : site; })(),
          description: meta?.description, canonical: path,
          alternates: { sq: p.sq, ...(p.en ? { en: p.en } : {}) },
          page: { key: p.key, lang, query: req.query, ...(await pageForms(app, p.key, lang)) },
        });
      });
    }
  }

  // ─── Article detail (activities / publications) ───
  async function detail(req: FastifyRequest<{ Params: { id: string; slug?: string } }>, reply: FastifyReply, lang: Lang, section: "activity" | "publication") {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    const d = await articleDetail(db, id, lang);
    if (!d) return reply.callNotFound();
    const a = d.article;
    if (a.detailType === "LINK" && a.linkUrl) return reply.redirect(a.linkUrl, 302);
    if (a.detailType === "NONE") return reply.redirect(pagePath(d.kind === "activity" ? "activities" : "publications", lang), 302);
    const canonical = articlePath(d.kind, lang, a.id, d.tr.slug);
    if (d.kind !== section || (req.params.slug && decodeURIComponent(req.params.slug) !== d.tr.slug)) return reply.redirect(canonical, 301);
    if (!isBot(req)) await db.article.update({ where: { id: a.id }, data: { viewCount: { increment: 1 } } });

    const sqT = a.translations.find(t => t.lang === "sq"), enT = a.translations.find(t => t.lang === "en");
    const alternates: Partial<Record<Lang, string>> = {};
    if (sqT) alternates.sq = articlePath(d.kind, "sq", a.id, sqT.slug);
    if (enT || !a.hideDefaultLocale) alternates.en = articlePath(d.kind, "en", a.id, (enT ?? sqT)!.slug);
    const cover = a.cover && a.showCover ? `/files/${a.cover.id}/v/w1600/cover.webp` : null;
    return sendPage(reply, d.kind === "activity" ? "activity.html" : "item.html", lang, {
      title: `${d.tr.metaTitle ?? d.tr.title} — PIPS`,
      description: d.tr.metaDescription ?? textOf(d.tr.summary).slice(0, 300) ?? null,
      canonical, alternates, ogImage: cover, ogType: "article",
      page: { key: d.kind, lang, id: String(a.id), type: d.item.type, item: d.item },
    });
  }
  for (const lang of ["sq", "en"] as const) {
    for (const [section, key] of [["activity", "activities"], ["publication", "publications"]] as const) {
      const base = pagePath(key, lang);
      app.get<{ Params: { id: string; slug?: string } }>(`${base}/:id`, (req, reply) => detail(req, reply, lang, section));
      app.get<{ Params: { id: string; slug?: string } }>(`${base}/:id/:slug`, (req, reply) => detail(req, reply, lang, section));
    }
  }

  // ─── Prototype file names (/about.html, /en/activity.html?id=…) → pretty URLs ───
  const fileRedirect = (lang: Lang | null) => async (req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
    const l: Lang = lang ?? (/\/en(\/|$)/.test(new URL(req.headers.referer ?? "http://x/").pathname) ? "en" : "sq");
    const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    const to = prettyFromFile(`${req.params.file}.html`, q, l);
    return to ? reply.redirect(to, 301) : reply.callNotFound();
  };
  app.get("/:file.html", fileRedirect(null));
  app.get("/en/:file.html", fileRedirect("en"));

  // ─── Public files (content-addressed storage; private bucket never served here) ───
  async function sendStored(reply: FastifyReply, storageKey: string, mime: string, opts: { download?: string } = {}) {
    reply.header("Cache-Control", "public, max-age=31536000, immutable").type(mime);
    if (opts.download) reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`);
    return reply.sendFile(storageKey, storageDir);
  }
  app.get<{ Params: { id: string; name: string } }>("/files/:id/:name", async (req, reply) => {
    const f = await db.file.findFirst({ where: { id: Number(req.params.id) || -1, bucket: "PUBLIC" } });
    return f ? sendStored(reply, f.storageKey, f.mime) : reply.callNotFound();
  });
  app.get<{ Params: { id: string; kind: string; name: string } }>("/files/:id/v/:kind/:name", async (req, reply) => {
    const v = await db.fileVariant.findFirst({ where: { fileId: Number(req.params.id) || -1, kind: req.params.kind, file: { bucket: "PUBLIC" } } });
    return v ? sendStored(reply, v.storageKey, v.mime) : reply.callNotFound();
  });

  // ─── Documents: in-page viewing (?inline=1) or download; download counter as in DNN ───
  app.get<{ Params: { id: string; name: string }; Querystring: { inline?: string } }>("/docs/:id/:name", async (req, reply) => {
    const d = await db.document.findFirst({ where: { id: Number(req.params.id) || -1, visible: true, file: { bucket: "PUBLIC" } }, include: { file: true } });
    if (!d?.file) return reply.callNotFound();
    if (!isBot(req) && !req.headers.range) await db.document.update({ where: { id: d.id }, data: { downloadCount: { increment: 1 } } });
    const name = d.fileName.replace(/\.resources$/i, "");
    reply.header("Cache-Control", "public, max-age=86400").type(d.file.mime);
    reply.header("Content-Disposition", `${req.query.inline === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.sendFile(d.file.storageKey, storageDir);
  });

  // ─── Search (keyword + program/year filters; documents' titles included) ───
  app.get<{ Querystring: { q?: string; lang?: string; program?: string; year?: string; page?: string } }>("/api/public/search", async req => {
    const lang: Lang = req.query.lang === "en" ? "en" : "sq";
    const q = (req.query.q ?? "").trim().slice(0, 200);
    if (!q) return { q, total: 0, items: [] };
    const page = Math.max(1, Number(req.query.page) || 1), per = 20;
    const program = req.query.program ? Prisma.sql`AND EXISTS (SELECT 1 FROM "ArticleProgram" ap JOIN "Program" p ON p.id = ap."programId" WHERE ap."articleId" = a.id AND p.key = ${req.query.program})` : Prisma.empty;
    const year = Number(req.query.year) ? Prisma.sql`AND coalesce(a."publicationYear", extract(year FROM a."publishAt")::int) = ${Number(req.query.year)}` : Prisma.empty;
    const rows = await db.$queryRaw<{ id: number; lang: string; title: string; slug: string; snippet: string; publishAt: Date; isActivity: boolean; total: bigint }[]>`
      WITH q AS (SELECT websearch_to_tsquery('english', unaccent(${q})) AS en, websearch_to_tsquery('simple', unaccent(${q})) AS sq)
      SELECT a.id, t.lang::text, t.title, t.slug, a."publishAt",
             EXISTS (SELECT 1 FROM "ArticleCategory" ac JOIN "Category" c ON c.id = ac."categoryId" WHERE ac."articleId" = a.id AND c."legacyId" = ${CAT.activities}) AS "isActivity",
             ts_headline(CASE WHEN t.lang = 'en' THEN 'english'::regconfig ELSE 'simple'::regconfig END, left(regexp_replace(coalesce(t.summary, '') || ' ' || t."bodyText", '<[^>]+>', ' ', 'g'), 20000),
                         CASE WHEN t.lang = 'en' THEN q.en ELSE q.sq END, 'MaxWords=30, MinWords=12, StartSel=[[[, StopSel=]]]') AS snippet,
             count(*) OVER () AS total
      FROM "ArticleTranslation" t JOIN "Article" a ON a.id = t."articleId", q
      WHERE a.status = 'PUBLISHED' AND a."deletedAt" IS NULL AND a."publishAt" <= now() AND (a."expireAt" IS NULL OR a."expireAt" > now())
        AND a."detailType" <> 'NONE'
        AND t.search @@ (CASE WHEN t.lang = 'en' THEN q.en ELSE q.sq END)
        AND (t.lang::text = ${lang} OR (${lang} = 'en' AND t.lang = 'sq' AND NOT a."hideDefaultLocale"
             AND NOT EXISTS (SELECT 1 FROM "ArticleTranslation" e WHERE e."articleId" = a.id AND e.lang = 'en')))
        ${program} ${year}
      ORDER BY ts_rank(t.search, CASE WHEN t.lang = 'en' THEN q.en ELSE q.sq END) DESC, a."publishAt" DESC
      LIMIT ${per} OFFSET ${(page - 1) * per}`;
    return {
      q, page, total: Number(rows[0]?.total ?? 0),
      items: rows.map(r => ({
        id: r.id, title: r.title, date: fmtDate(r.publishAt, lang), lang: r.lang,
        // escape everything, then turn only our highlight markers into <mark>
        snippet: r.snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[\[\[/g, "<mark>").replace(/\]\]\]/g, "</mark>"),
        kind: r.isActivity ? "activity" : "publication", href: articlePath(r.isActivity ? "activity" : "publication", lang, r.id, r.slug),
      })),
    };
  });

  // ─── RSS (one feed per section, per language) ───
  async function rss(reply: FastifyReply, feed: "activities" | "publications", lang: Lang) {
    const { data } = await siteData(db, lang, webDir);
    const items = ((data as Record<string, { title: string; href: string | null; excerpt?: string; summary?: string; iso: string }[]>)[feed] ?? []).slice(0, 30);
    const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
    const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const link = (h: string | null) => (h && /^https?:/.test(h) ? h : base + (h ?? pagePath(feed, lang)));
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>PIPS — ${feed === "activities" ? (lang === "en" ? "Activities" : "Aktivitetet") : (lang === "en" ? "Publications" : "Publikimet")}</title><link>${base}${pagePath(feed, lang)}</link><language>${lang}</language><description>Prishtina Institute for Political Studies</description>${items.map(i => `<item><title>${x(i.title)}</title><link>${x(link(i.href))}</link><guid>${x(link(i.href))}</guid><pubDate>${new Date(i.iso).toUTCString()}</pubDate><description>${x(i.excerpt ?? i.summary ?? "")}</description></item>`).join("")}</channel></rss>`;
    return reply.type("application/rss+xml; charset=utf-8").send(body);
  }
  app.get<{ Params: { feed: string } }>("/rss/:feed.xml", (req, reply) => rss(reply, req.params.feed === "publications" ? "publications" : "activities", "sq"));
  app.get<{ Params: { feed: string } }>("/en/rss/:feed.xml", (req, reply) => rss(reply, req.params.feed === "publications" ? "publications" : "activities", "en"));

  // ─── Sitemap & robots ───
  app.get("/sitemap.xml", async (_req, reply) => {
    const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
    const urls: string[] = [];
    const entry = (sq: string | null, en: string | null, lastmod?: Date) => {
      for (const loc of [sq, en].filter(Boolean) as string[]) {
        urls.push(`<url><loc>${base}${loc}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ""}${sq ? `<xhtml:link rel="alternate" hreflang="sq" href="${base}${sq}"/>` : ""}${en ? `<xhtml:link rel="alternate" hreflang="en" href="${base}${en}"/>` : ""}</url>`);
      }
    };
    for (const p of PAGES.filter(p => !p.requiredPermission && p.key !== "search")) entry(p.sq, p.en);
    const { byId } = await siteData(db, "sq", webDir);
    for (const a of byId.values()) {
      if (a.detailType !== "TEXT") continue;
      const kind = a.categories.some(c => c.category.legacyId === CAT.activities) ? "activity" : a.categories.some(c => c.category.legacyId === CAT.publications) ? "publication" : null;
      if (!kind) continue;
      const sq = a.translations.find(t => t.lang === "sq"), en = a.translations.find(t => t.lang === "en");
      entry(sq ? articlePath(kind, "sq", a.id, sq.slug) : null, en ? articlePath(kind, "en", a.id, en.slug) : null, a.updatedAt);
    }
    return reply.type("application/xml; charset=utf-8").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls.join("")}</urlset>`);
  });
  app.get("/robots.txt", async (_req, reply) =>
    reply.type("text/plain").send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/\nAllow: /\nSitemap: ${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/sitemap.xml\n`));

  // ─── Legacy DNN URLs → new site (only for requests no route matched) ───
  app.setNotFoundHandler(async (req, reply) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const lang: Lang = /^\/en(\/|$)/i.test(path) ? "en" : "sq";
    if (req.method === "GET" || req.method === "HEAD") {
      const lower = path.toLowerCase();
      // Applicant uploads were stored under the public Portals folder in DNN: never served again.
      if (lower.startsWith("/portals/0/digform/")) return reply.code(410).type("text/plain").send("Gone");
      // Old document handler: /DesktopModules/EasyDNNNews/DocumentDownload.ashx?…&documentid=Y
      if (lower.includes("documentdownload.ashx")) {
        const docId = Number(url.searchParams.get("documentid") ?? url.searchParams.get("documentId"));
        const d = docId ? await db.document.findUnique({ where: { legacyId: docId } }) : null;
        if (d) return reply.redirect(docUrl(d), 301);
      }
      // Old files: /Portals/0/EasyDNNNews/…, /Portals/0/EasyGalleryImages/…, /Portals/0/Images/…
      if (lower.startsWith("/portals/")) {
        const lp = await db.legacyPath.findUnique({ where: { path: legacyKey(path) }, include: { file: true } });
        if (lp?.file && lp.file.bucket === "PUBLIC") return reply.redirect(`/files/${lp.file.id}/${encodeURIComponent(lp.file.originalName)}`, 301);
      }
      // Old article URLs: …/ArtMID/1444/ArticleID/4182/slug
      const art = /\/articleid\/(\d+)/i.exec(path);
      if (art) {
        const a = await db.article.findUnique({ where: { legacyId: Number(art[1]) }, include: { translations: true, categories: { include: { category: true } } } });
        if (a) {
          // DNN "Link" items (partners, donors…) go straight to their external site; "None" items to their list.
          if (a.detailType === "LINK" && a.linkUrl) return reply.redirect(a.linkUrl, 301);
          const kind = a.categories.some(c => c.category.legacyId === CAT.activities) ? "activity" : "publication";
          if (a.detailType === "NONE") return reply.redirect(pagePath(kind === "activity" ? "activities" : "publications", lang), 301);
          const t = a.translations.find(x => x.lang === lang) ?? a.translations.find(x => x.lang === "sq");
          if (t) return reply.redirect(articlePath(kind, lang, a.id, t.slug), 301);
        }
      }
      // Old category and author listings, RSS
      const cat = /\/categoryid\/(\d+)/i.exec(path);
      if (cat) {
        const c = Number(cat[1]);
        const key = c === CAT.activities ? "activities" : c === CAT.publications ? "publications" : [CAT.team, CAT.board, CAT.pipsEngages, 2].includes(c as never) ? "about"
          : (CAT.donors as readonly number[]).includes(c) || c === CAT.partners ? "donors" : [CAT.sopAbout, CAT.worldForum, CAT.alumni, CAT.network, 3].includes(c as never) ? "school-of-politics"
          : (CAT.programIntros as readonly number[]).includes(c) || c === 4 ? "programs" : "home";
        return reply.redirect(pagePath(key, lang), 301);
      }
      if (/\/authorid\/\d+/i.test(path)) return reply.redirect(pagePath("activities", lang), 301);
      const rssMid = /\/ctl\/rss\/mid\/(\d+)/i.exec(path);
      if (rssMid) {
        const u = await db.legacyUrl.findFirst({ where: { linkType: 8, moduleId: Number(rssMid[1]) } });
        const pub = u && [38, 1109, 44, 1112].includes(u.tabId);
        return reply.redirect(`${lang === "en" ? "/en" : ""}/rss/${pub ? "publications" : "activities"}.xml`, 301);
      }
      // Exact page redirects (TabUrls and old page names)
      const r = await db.redirect.findUnique({ where: { fromPath: normPath(path) } });
      if (r) {
        await db.redirect.update({ where: { id: r.id }, data: { hits: { increment: 1 }, lastHitAt: new Date() } });
        return r.code === 410 || !r.toPath ? reply.code(410).send("Gone") : reply.redirect(r.toPath, r.code === 302 ? 302 : 301);
      }
      // Pretty path with different casing or a trailing slash
      const m = matchPath(path.toLowerCase());
      if (m && path !== path.toLowerCase()) return reply.redirect(path.toLowerCase() + url.search, 301);
    }
    if (path.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
    return reply.code(404).type("text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — PIPS</title><body style="font-family:system-ui;padding:48px;max-width:640px"><h1>${lang === "en" ? "Page not found" : "Faqja nuk u gjet"}</h1><p>${lang === "en" ? "The page you are looking for does not exist or has moved." : "Faqja që kërkoni nuk ekziston ose është zhvendosur."}</p><p><a href="${lang === "en" ? "/en" : "/"}">${lang === "en" ? "Home" : "Ballina"}</a> · <a href="${pagePath("search", lang)}">${lang === "en" ? "Search" : "Kërkimi"}</a></p></body>`);
  });
}
