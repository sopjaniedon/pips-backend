import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { clean, decodeHtml, normPath, sanitize } from "../lib/text.js";
import { TAB_ROUTES, tabTarget, type Lang } from "../config/site-map.js";
import type { Step } from "./types.js";

const langOf = (culture: string | null | undefined): Lang => ((culture ?? "").toLowerCase().startsWith("en") ? "en" : "sq");

export const htmlBlocksStep: Step = {
  id: "13",
  name: "static HTML blocks (DNN HTML module) with full version history",
  async run() {
    const versions = await select<{ ItemID: number; ModuleID: number; Content: string | null; Version: number | null; IsPublished: boolean | null; CreatedOnDate: Date | null; LastModifiedOnDate: Date | null; LastModifiedByUserID: number | null }>(
      "SELECT ItemID, ModuleID, Content, Version, IsPublished, CreatedOnDate, LastModifiedOnDate, LastModifiedByUserID FROM HtmlText ORDER BY ModuleID, Version",
    );
    const placements = await select<{ ModuleID: number; TabID: number; PaneName: string; ModuleOrder: number; ModuleTitle: string | null; TmCulture: string | null; TabCulture: string | null; TmDeleted: boolean; TabDeleted: boolean; ModDeleted: boolean; AllTabs: boolean }>(
      `SELECT tm.ModuleID, tm.TabID, tm.PaneName, tm.ModuleOrder, tm.ModuleTitle, tm.CultureCode TmCulture, t.CultureCode TabCulture,
              tm.IsDeleted TmDeleted, t.IsDeleted TabDeleted, m.IsDeleted ModDeleted, m.AllTabs
       FROM TabModules tm JOIN Tabs t ON t.TabID = tm.TabID JOIN Modules m ON m.ModuleID = tm.ModuleID
       WHERE tm.ModuleID IN (SELECT DISTINCT ModuleID FROM HtmlText)`,
    );
    const users = new Map((await db.user.findMany({ select: { id: true, legacyId: true } })).map(u => [u.legacyId, u.id]));
    const modules = [...new Set(versions.map(v => v.ModuleID))];
    let live = 0, revisions = 0;
    for (const moduleId of modules) {
      const vs = versions.filter(v => v.ModuleID === moduleId);
      const ps = placements.filter(p => p.ModuleID === moduleId);
      const livePs = ps.filter(p => !p.TmDeleted && !p.TabDeleted && !p.ModDeleted);
      const p = livePs[0] ?? ps[0];
      const isLive = livePs.length > 0;
      if (isLive) live++;
      const current = [...vs].reverse().find(v => v.IsPublished) ?? vs[vs.length - 1];
      const lang = langOf(p?.TmCulture ?? p?.TabCulture);
      const data = {
        lang, html: sanitize(decodeHtml(current?.Content)), title: clean(p?.ModuleTitle),
        pageKey: p?.AllTabs ? null : p ? TAB_ROUTES[p.TabID] ?? `tab-${p.TabID}` : null,
        pane: p?.PaneName ?? null, position: p?.ModuleOrder ?? 0, isLive, legacyModuleId: moduleId, legacyTabId: p?.TabID ?? null,
        updatedAt: current?.LastModifiedOnDate ?? current?.CreatedOnDate ?? new Date(0),
      };
      const key = `m${moduleId}`;
      const block = await db.htmlBlock.upsert({ where: { key_lang: { key, lang } }, update: data, create: { ...data, key } });
      for (const v of vs) {
        const r = { blockId: block.id, version: v.Version ?? 0, html: decodeHtml(v.Content), isPublished: !!v.IsPublished, createdAt: v.LastModifiedOnDate ?? v.CreatedOnDate ?? new Date(0), createdById: v.LastModifiedByUserID ? users.get(v.LastModifiedByUserID) ?? null : null };
        await db.htmlBlockRevision.upsert({ where: { legacyItemId: v.ItemID }, update: r, create: { ...r, legacyItemId: v.ItemID } });
        revisions++;
      }
    }
    return { htmlModules: modules.length, htmlBlocksLive: live, htmlVersions: revisions };
  },
};

export const pagesStep: Step = {
  id: "14",
  name: "pages (SEO meta), redirects for old page URLs, and the legacy article/category URL registry",
  async run() {
    const tabs = await select<{ TabID: number; TabName: string; Title: string | null; Description: string | null; KeyWords: string | null; PageHeadText: string | null; Url: string | null; IsVisible: boolean; CultureCode: string | null }>(
      "SELECT TabID, TabName, Title, Description, KeyWords, PageHeadText, Url, IsVisible, CultureCode FROM Tabs WHERE PortalID = 0 AND IsDeleted = 0 AND CultureCode IS NOT NULL ORDER BY TabID",
    );
    const allUsersView = new Set((await select<{ TabID: number }>(
      "SELECT DISTINCT tp.TabID FROM TabPermission tp JOIN Permission p ON p.PermissionID = tp.PermissionID WHERE tp.RoleID = -1 AND p.PermissionKey = 'VIEW' AND tp.AllowAccess = 1",
    )).map(r => r.TabID));

    const usedKeys = new Set<string>();
    let pages = 0;
    for (const t of tabs) {
      const lang = langOf(t.CultureCode);
      let routeKey = TAB_ROUTES[t.TabID] ?? `legacy-${t.TabID}`;
      if (usedKeys.has(`${routeKey}:${lang}`)) routeKey = `${routeKey}-${t.TabID}`;
      usedKeys.add(`${routeKey}:${lang}`);
      const data = {
        routeKey, lang, title: clean(t.Title) ?? t.TabName.trim(), description: clean(t.Description), keywords: clean(t.KeyWords),
        headHtml: clean(t.PageHeadText), externalUrl: /^https?:/i.test(t.Url ?? "") ? t.Url : null, inMenu: t.IsVisible,
        requiredPermission: allUsersView.has(t.TabID) ? null : TAB_ROUTES[t.TabID] === "alumni" ? "page.alumni.view" : "page.restricted",
        legacyName: t.TabName.trim(),
      };
      await db.pageMeta.upsert({ where: { legacyTabId: t.TabID }, update: data, create: { ...data, legacyTabId: t.TabID } });
      pages++;
    }

    // Old page URLs → new routes. DNN friendly URLs: /{lang}/{Tab-Name}; the default alias (no lang) is Albanian.
    const redirects = new Map<string, string>();
    const add = (from: string, to: string) => { const f = normPath(from); if (f !== normPath(to) && !redirects.has(f)) redirects.set(f, to); };
    for (const t of tabs) {
      const lang = langOf(t.CultureCode), to = tabTarget(t.TabID, lang), slug = t.TabName.trim().replace(/\s+/g, "-");
      add(`/${lang === "en" ? "en" : "sq"}/${slug}`, to);
      if (lang === "sq") add(`/${slug}`, to);
    }
    const tabUrls = await select<{ TabId: number; Url: string; CultureCode: string | null }>("SELECT TabId, Url, CultureCode FROM TabUrls ORDER BY TabId, SeqNum");
    for (const u of tabUrls) {
      const lang = langOf(u.CultureCode), to = tabTarget(u.TabId, lang);
      add(`/${lang === "en" ? "en" : "sq"}${u.Url}`, to);
      if (lang === "sq") add(u.Url, to);
    }
    add("/sq", "/");
    await db.redirect.deleteMany({ where: { source: { in: ["TAB", "PAGE"] } } });
    await db.redirect.createMany({ data: [...redirects].map(([fromPath, toPath]) => ({ fromPath, toPath, code: 301, source: "PAGE" as const })) });

    // EasyDNNNews URL registry (articles, categories, authors, RSS). Built from the structured columns only;
    // OriginalUrlString is ignored (it contains logged attack probes, e.g. path traversal attempts).
    const urls = await select<{ ID: number; LinkType: number; TabID: number; ModuleID: number | null; ArtMID: number | null; ArticleID: number | null; CategoryID: number | null; authorid: number | null; LinkTitle: string }>(
      "SELECT ID, LinkType, TabID, ModuleID, ArtMID, ArticleID, CategoryID, authorid, LinkTitle FROM EasyDNNnewsUrlNewProviderData",
    );
    await db.legacyUrl.deleteMany({});
    await db.legacyUrl.createMany({
      data: urls.map(u => ({ id: u.ID, linkType: u.LinkType, tabId: u.TabID, moduleId: u.ArtMID ?? u.ModuleID, articleId: u.ArticleID, categoryId: u.CategoryID, authorId: u.authorid, slug: u.LinkTitle.normalize("NFC") })),
    });
    return { pages, pageRedirects: redirects.size, tabUrls: tabUrls.length, urlProviderRows: urls.length };
  },
};
