import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { clean, decodeHtml, realExpiry, sanitize, slugify, toText } from "../lib/text.js";
import { CATEGORY, CUSTOM_FIELD } from "../config/site-map.js";
import type { Step } from "./types.js";
import type { Prisma } from "@prisma/client";

interface LegacyArticle {
  ArticleID: number; UserID: number | null; Title: string; SubTitle: string | null; Summary: string | null; Article: string | null;
  ArticleImage: string | null; ArticleImageFolder: string | null; DateAdded: Date; LastModified: Date; PublishDate: Date; ExpireDate: Date | null;
  NumberOfViews: number; TitleLink: string; DetailType: string | null; DetailTypeData: string | null; DetailTarget: string | null;
  MetaDecription: string | null; MetaKeywords: string | null; TitleTag: string | null; OpenGraphMetaTags: string | null;
  ShowGallery: boolean; ArticleGalleryID: number | null; MainImageTitle: string | null; MainImageDescription: string | null;
  HideDefaultLocale: boolean; Featured: boolean; Approved: boolean; Active: boolean; Published: boolean; ShowMainImage: boolean;
}

interface LegacyLoc {
  ArticleID: number; Title: string; SubTitle: string | null; Summary: string | null; Article: string | null; clTitleLink: string;
  MetaDecription: string | null; MetaKeywords: string | null; TitleTag: string | null; MainImageTitle: string | null; MainImageDescription: string | null;
}

const detailType = (s: string | null): "TEXT" | "NONE" | "LINK" => {
  const t = (s ?? "").toLowerCase();
  return t === "none" ? "NONE" : t === "link" ? "LINK" : "TEXT";
};

/** Legacy fields → translation row. Rich text is sanitised; the raw text is kept in a LEGACY revision. */
function translation(x: { Title: string; SubTitle: string | null; Summary: string | null; Article: string | null; MetaDecription: string | null; MetaKeywords: string | null; TitleTag: string | null; MainImageTitle: string | null; MainImageDescription: string | null }, legacySlug: string | null, og: string | null) {
  const title = clean(decodeHtml(x.Title)) ?? "(untitled)";
  const bodyHtml = sanitize(decodeHtml(x.Article));
  const summaryHtml = sanitize(decodeHtml(x.Summary));
  return {
    title,
    subtitle: clean(toText(decodeHtml(x.SubTitle))),
    summary: summaryHtml || null,
    bodyHtml,
    bodyText: toText(bodyHtml),
    slug: slugify(title),
    legacySlug: clean(legacySlug),
    metaTitle: clean(x.TitleTag),
    metaDescription: clean(x.MetaDecription),
    metaKeywords: clean(x.MetaKeywords),
    ogJson: og ? ({ raw: og } as Prisma.InputJsonValue) : undefined,
    coverTitle: clean(x.MainImageTitle),
    coverDescription: clean(x.MainImageDescription),
  };
}

export const articlesStep: Step = {
  id: "08",
  name: "articles + English translations (sanitised; raw kept as LEGACY revision)",
  async run() {
    const rows = await select<LegacyArticle>(
      `SELECT ArticleID, UserID, Title, SubTitle, Summary, Article, ArticleImage, ArticleImageFolder, DateAdded, LastModified, PublishDate, ExpireDate,
              NumberOfViews, TitleLink, DetailType, DetailTypeData, DetailTarget, MetaDecription, MetaKeywords, TitleTag, OpenGraphMetaTags,
              ShowGallery, ArticleGalleryID, MainImageTitle, MainImageDescription, HideDefaultLocale, Featured, Approved, Active, Published, ShowMainImage
       FROM EasyDNNNews WHERE PortalID = 0 ORDER BY ArticleID`,
    );
    const locs = await select<LegacyLoc>(
      `SELECT ArticleID, Title, SubTitle, Summary, Article, clTitleLink, MetaDecription, MetaKeywords, TitleTag, MainImageTitle, MainImageDescription
       FROM EasyDNNNewsContentLocalization WHERE LocaleCode = 'en-GB'`,
    );
    const enBy = new Map(locs.map(l => [l.ArticleID, l]));
    const users = new Map((await db.user.findMany({ select: { id: true, legacyId: true } })).map(u => [u.legacyId, u.id]));
    let published = 0, withCover = 0, enRows = 0;

    for (const a of rows) {
      const status = a.Active && a.Approved && a.Published ? "PUBLISHED" as const : "DRAFT" as const;
      if (status === "PUBLISHED") published++;
      const image = clean(a.ArticleImage);
      if (image) withCover++;
      const data = {
        status, publishAt: a.PublishDate, expireAt: realExpiry(a.ExpireDate),
        featured: a.Featured, detailType: detailType(a.DetailType),
        linkUrl: detailType(a.DetailType) === "LINK" ? clean(a.DetailTypeData) : null,
        linkTarget: clean(a.DetailTarget),
        legacyCoverPath: image ? `/Portals/0/${clean(a.ArticleImageFolder) ?? "EasyDNNNews"}/${a.ArticleID}/${image}` : null,
        showCover: a.ShowMainImage, showGallery: a.ShowGallery,
        hideDefaultLocale: a.HideDefaultLocale, viewCount: a.NumberOfViews,
        authorId: a.UserID ? users.get(a.UserID) ?? null : null,
        legacyGalleryId: a.ArticleGalleryID,
        createdAt: a.DateAdded, updatedAt: a.LastModified,
      };
      const art = await db.article.upsert({ where: { legacyId: a.ArticleID }, update: data, create: { ...data, legacyId: a.ArticleID } });

      const sq = translation(a, a.TitleLink, clean(a.OpenGraphMetaTags));
      await db.articleTranslation.upsert({
        where: { articleId_lang: { articleId: art.id, lang: "sq" } },
        update: { ...sq, updatedAt: a.LastModified }, create: { ...sq, articleId: art.id, lang: "sq", updatedAt: a.LastModified },
      });
      const l = enBy.get(a.ArticleID);
      if (l) {
        const en = translation(l, l.clTitleLink, null);
        await db.articleTranslation.upsert({
          where: { articleId_lang: { articleId: art.id, lang: "en" } },
          update: { ...en, updatedAt: a.LastModified }, create: { ...en, articleId: art.id, lang: "en", updatedAt: a.LastModified },
        });
        enRows++;
      }
      // Raw legacy content, unsanitised, for audit/rollback. Negative legacyId = "imported original" (archive rows are positive).
      const raw = { kind: "legacy-original", sq: { title: a.Title, subtitle: a.SubTitle, summary: a.Summary, article: a.Article }, en: l ? { title: l.Title, subtitle: l.SubTitle, summary: l.Summary, article: l.Article } : null };
      await db.articleRevision.upsert({
        where: { legacyId: -a.ArticleID },
        update: { snapshot: raw, createdAt: a.LastModified },
        create: { legacyId: -a.ArticleID, articleId: art.id, source: "LEGACY", snapshot: raw, createdAt: a.LastModified },
      });
    }
    return { articles: rows.length, published, withCoverPath: withCover, translationsSq: rows.length, translationsEn: enRows };
  },
};

const ANALYTICAL = [
  { type: "Policy Brief", re: /policy\s*brief|brief|përmbledhje politik/i },
  { type: "Report", re: /\b(raport|report|monitorim|monitoring|index|indeks)/i },
  { type: "Research Paper", re: /\b(research|hulumtim|studim|study|analiz|analysis|paper|punim)/i },
];

export const linksStep: Step = {
  id: "09",
  name: "article ↔ categories, programs, publication year; Research type (Publikimet heuristic)",
  async run() {
    const arts = new Map((await db.article.findMany({ select: { id: true, legacyId: true } })).map(a => [a.legacyId!, a.id]));
    const cats = new Map((await db.category.findMany({ select: { id: true, legacyId: true } })).map(c => [c.legacyId!, c.id]));
    const progs = new Map((await db.program.findMany({ select: { id: true, legacyId: true } })).map(p => [p.legacyId!, p.id]));

    const ac = await select<{ ArticleID: number; CategoryID: number }>("SELECT DISTINCT ArticleID, CategoryID FROM EasyDNNNewsCategories");
    const sel = await select<{ ArticleID: number; CustomFieldID: number; FieldElementID: number; Text: string }>(
      `SELECT s.ArticleID, s.CustomFieldID, s.FieldElementID, e.Text FROM EasyDNNfieldsMultiSelected s JOIN EasyDNNfieldsMultiElements e ON e.FieldElementID = s.FieldElementID`,
    );

    const ids = [...arts.values()];
    await db.articleCategory.deleteMany({ where: { articleId: { in: ids } } });
    await db.articleProgram.deleteMany({ where: { articleId: { in: ids } } });
    const catRows = ac.filter(x => arts.has(x.ArticleID) && cats.has(x.CategoryID)).map(x => ({ articleId: arts.get(x.ArticleID)!, categoryId: cats.get(x.CategoryID)! }));
    await db.articleCategory.createMany({ data: catRows, skipDuplicates: true });
    const progRows = sel.filter(x => x.CustomFieldID === CUSTOM_FIELD.programs && arts.has(x.ArticleID) && progs.has(x.FieldElementID))
      .map(x => ({ articleId: arts.get(x.ArticleID)!, programId: progs.get(x.FieldElementID)! }));
    await db.articleProgram.createMany({ data: progRows, skipDuplicates: true });

    // Year: one value per article in practice; keep the latest if several and report it.
    const years = new Map<number, number[]>();
    for (const x of sel.filter(s => s.CustomFieldID === CUSTOM_FIELD.year)) {
      const y = parseInt(x.Text, 10);
      if (!Number.isNaN(y) && arts.has(x.ArticleID)) years.set(x.ArticleID, [...(years.get(x.ArticleID) ?? []), y]);
    }
    let multiYear = 0;
    await db.article.updateMany({ where: { id: { in: ids } }, data: { publicationYear: null, analyticalType: null } });
    for (const [legacyId, ys] of years) {
      if (ys.length > 1) multiYear++;
      await db.article.update({ where: { id: arts.get(legacyId)! }, data: { publicationYear: Math.max(...ys) } });
    }

    // Research view: Publikimet items whose title/summary reads as analytical output. Editors can change it later.
    const pubCat = cats.get(CATEGORY.publications)!;
    const pubs = await db.article.findMany({ where: { categories: { some: { categoryId: pubCat } } }, select: { id: true, translations: { where: { lang: "sq" }, select: { title: true, summary: true } } } });
    let analytical = 0;
    for (const p of pubs) {
      const hay = `${p.translations[0]?.title ?? ""} ${p.translations[0]?.summary ?? ""}`;
      const hit = ANALYTICAL.find(a => a.re.test(hay));
      if (hit) { analytical++; await db.article.update({ where: { id: p.id }, data: { analyticalType: hit.type } }); }
    }
    const yearValues = sel.filter(s => s.CustomFieldID === CUSTOM_FIELD.year).length;
    return { articleCategories: catRows.length, articlePrograms: progRows.length, yearValues, programYearValues: progRows.length + yearValues, articlesWithYear: years.size, multiYearArticles: multiYear, researchTyped: analytical, publications: pubs.length };
  },
};

export const documentsStep: Step = {
  id: "10",
  name: "documents (PDF/DOC) attached to articles, with download counters",
  async run() {
    const docs = await select<{ DocEntryID: number; DateUploaded: Date | null; FilePath: string; Title: string | null; Description: string | null; NumberOfDownloads: number; FileSize: number; FileExtension: string; FileName: string; AllLanguages: boolean; Visible: boolean; Target: number }>(
      "SELECT DocEntryID, DateUploaded, FilePath, Title, Description, NumberOfDownloads, FileSize, FileExtension, FileName, AllLanguages, Visible, Target FROM EasyDNNNewsDocuments",
    );
    for (const d of docs) {
      const data = {
        title: clean(d.Title), description: clean(d.Description), legacyPath: d.FilePath.normalize("NFC"),
        fileName: d.FileName.normalize("NFC"), extension: d.FileExtension.replace(/^\./, "").toLowerCase(), size: BigInt(d.FileSize),
        downloadCount: d.NumberOfDownloads, allLanguages: d.AllLanguages, visible: d.Visible, openInNewTab: d.Target === 1, uploadedAt: d.DateUploaded,
      };
      await db.document.upsert({ where: { legacyId: d.DocEntryID }, update: data, create: { ...data, legacyId: d.DocEntryID } });
    }
    const items = await select<{ ArticleID: number; DocumentID: number; Position: number }>("SELECT ArticleID, DocumentID, Position FROM EasyDNNNewsDocumentItems");
    const arts = new Map((await db.article.findMany({ select: { id: true, legacyId: true } })).map(a => [a.legacyId!, a.id]));
    const dmap = new Map((await db.document.findMany({ select: { id: true, legacyId: true } })).map(d => [d.legacyId!, d.id]));
    await db.articleDocument.deleteMany({ where: { documentId: { in: [...dmap.values()] } } });
    const rows = items.filter(i => arts.has(i.ArticleID) && dmap.has(i.DocumentID)).map(i => ({ articleId: arts.get(i.ArticleID)!, documentId: dmap.get(i.DocumentID)!, position: i.Position }));
    await db.articleDocument.createMany({ data: rows, skipDuplicates: true });
    return { documents: docs.length, documentLinks: rows.length, downloadsTotal: docs.reduce((s, d) => s + d.NumberOfDownloads, 0) };
  },
};

export const galleryStep: Step = {
  id: "11",
  name: "article galleries (images + YouTube embeds; copies of the cover image hidden)",
  async run() {
    const pics = await select<{ PictureID: number; GalleryID: number | null; Title: string | null; Description: string | null; FileName: string | null; Position: number | null; MediaType: string | null; ShortEmbedUrl: string | null; ShowMedia: string | null; DateUploaded: Date | null }>(
      "SELECT PictureID, GalleryID, Title, Description, FileName, Position, MediaType, ShortEmbedUrl, ShowMedia, DateUploaded FROM EasyGalleryPictures",
    );
    const byGallery = new Map((await db.article.findMany({ where: { legacyGalleryId: { not: null } }, select: { id: true, legacyGalleryId: true } })).map(a => [a.legacyGalleryId!, a.id]));
    let videos = 0, hidden = 0, orphan = 0;
    for (const p of pics) {
      const isVideo = /video/i.test(p.MediaType ?? "");
      const embedSrc = isVideo ? (clean(p.ShortEmbedUrl) ?? /src="([^"]+)"/i.exec(decodeHtml(p.FileName))?.[1] ?? null) : null;
      const visible = (p.ShowMedia ?? "True").toLowerCase() !== "false";
      if (isVideo) videos++;
      if (!visible) hidden++;
      const articleId = p.GalleryID ? byGallery.get(p.GalleryID) ?? null : null;
      if (!articleId) orphan++;
      const data = {
        articleId, legacyGalleryId: p.GalleryID, position: p.Position ?? 0, mediaType: isVideo ? "VIDEO" as const : "IMAGE" as const,
        legacyPath: isVideo ? null : clean(p.FileName), embedUrl: embedSrc,
        title: clean(p.Title), description: clean(toText(decodeHtml(p.Description))), visible, isCoverCopy: !visible, uploadedAt: p.DateUploaded,
      };
      await db.galleryItem.upsert({ where: { legacyId: p.PictureID }, update: data, create: { ...data, legacyId: p.PictureID } });
    }
    return { galleryPictures: pics.length, videos, coverCopiesHidden: hidden, orphanGalleryItems: orphan };
  },
};

export const revisionsStep: Step = {
  id: "12",
  name: "article revision history (EasyDNNNewsArchive)",
  async run() {
    const rows = await select<{ HistoryEntryID: number; ArticleID: number | null; UserID: number; Title: string; SubTitle: string | null; Summary: string | null; Article: string | null; LastModified: Date | null; PublishDate: Date | null; HistoryVersion: number | null; Featured: boolean; ArticleImage: string | null }>(
      "SELECT HistoryEntryID, ArticleID, UserID, Title, SubTitle, Summary, Article, LastModified, PublishDate, HistoryVersion, Featured, ArticleImage FROM EasyDNNNewsArchive",
    );
    const arts = new Map((await db.article.findMany({ select: { id: true, legacyId: true } })).map(a => [a.legacyId!, a.id]));
    const users = new Map((await db.user.findMany({ select: { id: true, legacyId: true } })).map(u => [u.legacyId, u.id]));
    let imported = 0, skipped = 0;
    for (const r of rows) {
      const articleId = r.ArticleID ? arts.get(r.ArticleID) : undefined;
      if (!articleId) { skipped++; continue; }
      const snapshot = { kind: "legacy-archive", version: r.HistoryVersion, sq: { title: r.Title, subtitle: r.SubTitle, summary: r.Summary, article: r.Article }, publishAt: r.PublishDate, featured: r.Featured, coverImage: r.ArticleImage };
      const data = { articleId, source: "LEGACY" as const, snapshot, createdAt: r.LastModified ?? new Date(0), createdById: users.get(r.UserID) ?? null };
      await db.articleRevision.upsert({ where: { legacyId: r.HistoryEntryID }, update: data, create: { ...data, legacyId: r.HistoryEntryID } });
      imported++;
    }
    return { archiveRows: rows.length, articleRevisions: imported, skippedNoArticle: skipped };
  },
};
