// Content admin (EasyDNNNews, HTML module and file manager parity): articles with translations, categories,
// programs, documents, gallery, revisions, HTML blocks and media.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import he from "he";
import type { Prisma } from "@prisma/client";
import { paths } from "../lib/paths.js";
import { clean, sanitize, slugify, toText } from "../lib/html.js";
import { commitFile, discard, safeName, spool, type Spooled } from "../lib/storage.js";
import { sniff } from "../lib/sniff.js";
import { isRaster, makeVariants } from "../lib/images.js";
import { invalidateSiteData, docUrl } from "../site/data.js";
import { audit, canEditLang, page, routes } from "./registry.js";

const fileUrl = (f: { id: number; originalName: string }, kind?: string) =>
  kind ? `/files/${f.id}/v/${kind}/${encodeURIComponent(f.originalName)}` : `/files/${f.id}/${encodeURIComponent(f.originalName)}`;
const LANGS = ["sq", "en"] as const;
type L = (typeof LANGS)[number];
const Lang = z.enum(LANGS);
const Id = z.coerce.number().int().positive();

const ARTICLE_INCLUDE = {
  translations: true, categories: true, programs: true,
  cover: { include: { variants: true } },
  documents: { include: { document: true }, orderBy: { position: "asc" } },
  gallery: { include: { file: { include: { variants: true } } }, orderBy: { position: "asc" } },
} satisfies Prisma.ArticleInclude;
type FullArticle = Prisma.ArticleGetPayload<{ include: typeof ARTICLE_INCLUDE }>;

const trDto = (t: FullArticle["translations"][number]) => ({
  title: t.title, subtitle: t.subtitle, summary: t.summary, bodyHtml: t.bodyHtml, slug: t.slug,
  metaTitle: t.metaTitle, metaDescription: t.metaDescription, metaKeywords: t.metaKeywords, updatedAt: t.updatedAt,
});
function articleDto(a: FullArticle) {
  const thumb = (f: { id: number; originalName: string; variants: { kind: string }[] }) => f.variants.some(v => v.kind === "w400") ? fileUrl(f, "w400") : fileUrl(f);
  return {
    id: a.id, legacyId: a.legacyId, status: a.status, publishAt: a.publishAt, expireAt: a.expireAt, featured: a.featured,
    detailType: a.detailType, linkUrl: a.linkUrl, linkTarget: a.linkTarget, showCover: a.showCover, showGallery: a.showGallery,
    publicationYear: a.publicationYear, analyticalType: a.analyticalType, hideDefaultLocale: a.hideDefaultLocale,
    viewCount: a.viewCount, createdAt: a.createdAt, updatedAt: a.updatedAt,
    cover: a.cover ? { fileId: a.cover.id, url: fileUrl(a.cover), thumb: thumb(a.cover) } : null,
    categories: a.categories.map(c => c.categoryId), programs: a.programs.map(p => p.programId),
    translations: Object.fromEntries(a.translations.map(t => [t.lang, trDto(t)])),
    documents: a.documents.map(d => ({
      id: d.document.id, position: d.position, title: d.document.title, fileName: d.document.fileName, extension: d.document.extension,
      size: Number(d.document.size), downloadCount: d.document.downloadCount, visible: d.document.visible, url: docUrl(d.document),
    })),
    gallery: a.gallery.map(g => ({
      id: g.id, position: g.position, mediaType: g.mediaType, embedUrl: g.embedUrl, title: g.title, description: g.description,
      visible: g.visible, isCoverCopy: g.isCoverCopy, fileId: g.fileId, url: g.file ? fileUrl(g.file) : null, thumb: g.file ? thumb(g.file) : null,
    })),
  };
}

/** What a revision stores: everything an editor can change on the article except files. */
function snapshot(a: FullArticle) {
  const d = articleDto(a);
  return {
    kind: "app",
    base: { status: d.status, publishAt: d.publishAt, expireAt: d.expireAt, featured: d.featured, detailType: d.detailType, linkUrl: d.linkUrl, linkTarget: d.linkTarget, showCover: d.showCover, showGallery: d.showGallery, publicationYear: d.publicationYear, analyticalType: d.analyticalType, hideDefaultLocale: d.hideDefaultLocale, coverFileId: d.cover?.fileId ?? null },
    categories: d.categories, programs: d.programs,
    translations: Object.fromEntries(Object.entries(d.translations).map(([l, t]) => [l, { title: t.title, subtitle: t.subtitle, summary: t.summary, bodyHtml: t.bodyHtml, slug: t.slug, metaTitle: t.metaTitle, metaDescription: t.metaDescription, metaKeywords: t.metaKeywords }])),
  };
}

const Base = z.object({
  status: z.enum(["PUBLISHED", "DRAFT"]), publishAt: z.coerce.date(), expireAt: z.coerce.date().nullable(),
  featured: z.boolean(), detailType: z.enum(["TEXT", "NONE", "LINK"]), linkUrl: z.string().url().max(2000).nullable(), linkTarget: z.enum(["_blank", "_self"]).nullable(),
  showCover: z.boolean(), showGallery: z.boolean(), publicationYear: z.number().int().min(1990).max(2100).nullable(),
  analyticalType: z.string().max(60).nullable(), hideDefaultLocale: z.boolean(), coverFileId: z.number().int().positive().nullable(),
  categories: z.array(z.number().int().positive()).max(50), programs: z.array(z.number().int().positive()).max(50),
}).partial();
const Translation = z.object({
  title: z.string().trim().min(1).max(500), subtitle: z.string().max(1000).nullable().optional(), summary: z.string().max(20000).nullable().optional(),
  bodyHtml: z.string().max(2_000_000).optional(), slug: z.string().max(120).optional(),
  metaTitle: z.string().max(300).nullable().optional(), metaDescription: z.string().max(1000).nullable().optional(), metaKeywords: z.string().max(1000).nullable().optional(),
});
type TranslationIn = z.infer<typeof Translation>;

function trData(t: TranslationIn, docTitles: string) {
  const body = sanitize(t.bodyHtml ?? "");
  return {
    title: t.title.normalize("NFC"), subtitle: clean(t.subtitle), summary: t.summary ? sanitize(t.summary) || null : null,
    bodyHtml: body, bodyText: toText(body), slug: slugify(t.slug || t.title),
    metaTitle: clean(t.metaTitle), metaDescription: clean(t.metaDescription), metaKeywords: clean(t.metaKeywords),
    documentTitles: docTitles, updatedAt: new Date(),
  };
}

export async function contentRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const { storageDir } = paths(config);
  const r = routes(app, "/api/admin");
  const READ = ["content.edit", "content.translate_en"] as const;
  const big = { bodyLimit: 4_000_000 }; // article bodies can be long
  const load = (id: number) => db.article.findFirst({ where: { id, deletedAt: null }, include: ARTICLE_INCLUDE });
  const docTitlesOf = async (articleId: number) =>
    (await db.articleDocument.findMany({ where: { articleId }, include: { document: true } })).map(d => d.document.title ?? d.document.fileName).join(" ");
  async function revise(req: FastifyRequest, a: FullArticle) {
    await db.articleRevision.create({ data: { articleId: a.id, source: "APP", snapshot: snapshot(a) as Prisma.InputJsonValue, createdById: req.admin!.user.id } });
  }
  const changed = () => invalidateSiteData();

  // ─── Articles ───
  r.get("/articles", [...READ], async req => {
    const q = req.query as Record<string, string>;
    const pg = page(q);
    const where: Prisma.ArticleWhereInput = { deletedAt: null };
    if (q.status === "PUBLISHED" || q.status === "DRAFT") where.status = q.status;
    if (q.category) where.categories = { some: { categoryId: Number(q.category) } };
    if (q.program) where.programs = { some: { programId: Number(q.program) } };
    if (q.year) where.publishAt = { gte: new Date(`${Number(q.year)}-01-01T00:00:00Z`), lt: new Date(`${Number(q.year) + 1}-01-01T00:00:00Z`) };
    if (q.featured === "1") where.featured = true;
    if (q.analytical === "1") where.analyticalType = { not: null };
    if (q.missing === "en") where.translations = { none: { lang: "en" } };
    if (q.q) where.translations = { some: { OR: [{ title: { contains: q.q, mode: "insensitive" } }, { bodyText: { contains: q.q, mode: "insensitive" } }] } };
    const sort = q.sort === "views" ? { viewCount: "desc" as const } : q.sort === "oldest" ? { publishAt: "asc" as const } : { publishAt: "desc" as const };
    const [total, rows] = await Promise.all([
      db.article.count({ where }),
      db.article.findMany({ where, orderBy: [sort, { id: "desc" }], take: pg.take, skip: pg.skip, include: { translations: { select: { lang: true, title: true } }, categories: true, programs: true, cover: { include: { variants: true } } } }),
    ]);
    return {
      total, page: pg.page, pageSize: pg.pageSize,
      items: rows.map(a => ({
        id: a.id, status: a.status, publishAt: a.publishAt, featured: a.featured, detailType: a.detailType, viewCount: a.viewCount,
        title: Object.fromEntries(a.translations.map(t => [t.lang, t.title])), categories: a.categories.map(c => c.categoryId), programs: a.programs.map(p => p.programId),
        thumb: a.cover ? fileUrl(a.cover, a.cover.variants.some(v => v.kind === "w400") ? "w400" : undefined) : null, updatedAt: a.updatedAt,
      })),
    };
  });

  r.get("/articles/:id", [...READ], async (req, reply) => {
    const a = await load(Id.parse(req.params.id));
    return a ? articleDto(a) : reply.code(404).send({ error: "notFound" });
  });

  const Create = z.object({ base: Base.optional(), translations: z.object({ sq: Translation, en: Translation.optional() }) });
  r.post("/articles", "content.edit", async (req, reply) => {
    const b = Create.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const { categories = [], programs = [], ...base } = b.data.base ?? {};
    const a = await db.article.create({
      data: {
        status: base.status ?? "DRAFT", publishAt: base.publishAt ?? new Date(), ...base, authorId: req.admin!.user.id,
        translations: { create: Object.entries(b.data.translations).filter(([, t]) => t).map(([lang, t]) => ({ lang: lang as L, ...trData(t!, "") })) },
        categories: { create: categories.map(categoryId => ({ categoryId })) },
        programs: { create: programs.map(programId => ({ programId })) },
      },
    });
    await audit(req, "article.create", "Article", a.id);
    changed();
    return articleDto((await load(a.id))!);
  }, big);

  const Update = z.object({ base: Base.optional(), translations: z.object({ sq: Translation.optional(), en: Translation.nullable().optional() }).optional() });
  r.put("/articles/:id", "content.edit", async (req, reply) => {
    const b = Update.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    await revise(req, a);
    const { categories, programs, ...base } = b.data.base ?? {};
    const docs = await docTitlesOf(a.id);
    await db.$transaction(async tx => {
      await tx.article.update({ where: { id: a.id }, data: { ...base, updatedAt: new Date() } });
      if (categories) { await tx.articleCategory.deleteMany({ where: { articleId: a.id } }); await tx.articleCategory.createMany({ data: categories.map(categoryId => ({ articleId: a.id, categoryId })) }); }
      if (programs) { await tx.articleProgram.deleteMany({ where: { articleId: a.id } }); await tx.articleProgram.createMany({ data: programs.map(programId => ({ articleId: a.id, programId })) }); }
      for (const lang of LANGS) {
        const t = b.data.translations?.[lang];
        if (t === null && lang === "en") await tx.articleTranslation.deleteMany({ where: { articleId: a.id, lang } });
        else if (t) await tx.articleTranslation.upsert({ where: { articleId_lang: { articleId: a.id, lang } }, update: trData(t, docs), create: { articleId: a.id, lang, ...trData(t, docs) } });
      }
    });
    await audit(req, "article.update", "Article", a.id, { fields: Object.keys(b.data.base ?? {}), langs: Object.keys(b.data.translations ?? {}) });
    changed();
    return articleDto((await load(a.id))!);
  }, big);

  // The English translator works here (and only on "en"); editors may use it for either language.
  r.put("/articles/:id/translations/:lang", [...READ], async (req, reply) => {
    const lang = Lang.parse(req.params.lang);
    if (!canEditLang(req, lang)) return reply.code(403).send({ error: "forbidden" });
    const t = Translation.safeParse(req.body);
    if (!t.success) return reply.code(400).send({ error: "invalid", issues: t.error.issues });
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    await revise(req, a);
    const data = trData(t.data, await docTitlesOf(a.id));
    await db.articleTranslation.upsert({ where: { articleId_lang: { articleId: a.id, lang } }, update: data, create: { articleId: a.id, lang, ...data } });
    await db.article.update({ where: { id: a.id }, data: { updatedAt: new Date() } });
    await audit(req, "article.translation", "Article", a.id, { lang });
    changed();
    return articleDto((await load(a.id))!);
  }, big);

  r.del("/articles/:id", "content.edit", async (req, reply) => {
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    await revise(req, a);
    await db.article.update({ where: { id: a.id }, data: { deletedAt: new Date(), status: "DRAFT" } });
    await audit(req, "article.delete", "Article", a.id);
    changed();
    return { ok: true };
  });

  r.get("/articles/:id/revisions", [...READ], async req => {
    const rows = await db.articleRevision.findMany({ where: { articleId: Id.parse(req.params.id) }, orderBy: { createdAt: "desc" }, select: { id: true, source: true, createdAt: true, createdById: true, snapshot: true } });
    const users = new Map((await db.user.findMany({ where: { id: { in: rows.map(r => r.createdById).filter((x): x is number => !!x) } }, select: { id: true, displayName: true } })).map(u => [u.id, u.displayName]));
    return rows.map(r => {
      const s = r.snapshot as { kind?: string; sq?: { title?: string }; translations?: { sq?: { title?: string } }; version?: number };
      return { id: r.id, source: r.source, kind: s.kind ?? null, version: s.version ?? null, createdAt: r.createdAt, by: r.createdById ? users.get(r.createdById) ?? null : null, title: s.translations?.sq?.title ?? s.sq?.title ?? null };
    });
  });

  r.get("/articles/:id/revisions/:rev", [...READ], async (req, reply) => {
    const rev = await db.articleRevision.findFirst({ where: { id: Id.parse(req.params.rev), articleId: Id.parse(req.params.id) } });
    return rev ?? reply.code(404).send({ error: "notFound" });
  });

  r.post("/articles/:id/revisions/:rev/restore", "content.edit", async (req, reply) => {
    const a = await load(Id.parse(req.params.id));
    const rev = await db.articleRevision.findFirst({ where: { id: Id.parse(req.params.rev), articleId: Id.parse(req.params.id) } });
    if (!a || !rev) return reply.code(404).send({ error: "notFound" });
    await revise(req, a);
    const s = rev.snapshot as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const docs = await docTitlesOf(a.id);
    await db.$transaction(async tx => {
      if (s.kind === "app") {
        await tx.article.update({ where: { id: a.id }, data: { ...s.base, publishAt: new Date(s.base.publishAt), expireAt: s.base.expireAt ? new Date(s.base.expireAt) : null, updatedAt: new Date() } });
        await tx.articleCategory.deleteMany({ where: { articleId: a.id } });
        await tx.articleCategory.createMany({ data: (s.categories as number[]).map(categoryId => ({ articleId: a.id, categoryId })), skipDuplicates: true });
        await tx.articleProgram.deleteMany({ where: { articleId: a.id } });
        await tx.articleProgram.createMany({ data: (s.programs as number[]).map(programId => ({ articleId: a.id, programId })), skipDuplicates: true });
        for (const [lang, t] of Object.entries(s.translations as Record<string, TranslationIn>)) {
          await tx.articleTranslation.upsert({ where: { articleId_lang: { articleId: a.id, lang: lang as L } }, update: trData(t, docs), create: { articleId: a.id, lang: lang as L, ...trData(t, docs) } });
        }
      } else {
        // DNN history entries hold the (entity-encoded) Albanian text only.
        const dec = (x: string | null | undefined) => { const v = (x ?? "").normalize("NFC"); return /&lt;\/?[a-z]/i.test(v) ? he.decode(v) : v; };
        for (const lang of ["sq", "en"] as const) {
          const t = s[lang];
          if (!t?.title) continue;
          const data = trData({ title: t.title, subtitle: t.subtitle, summary: dec(t.summary), bodyHtml: dec(t.article) }, docs);
          await tx.articleTranslation.update({ where: { articleId_lang: { articleId: a.id, lang } }, data: { ...data, slug: a.translations.find(x => x.lang === lang)?.slug ?? data.slug } }).catch(() => undefined);
        }
        await tx.article.update({ where: { id: a.id }, data: { updatedAt: new Date() } });
      }
    });
    await audit(req, "article.restore", "Article", a.id, { revision: rev.id });
    changed();
    return articleDto((await load(a.id))!);
  });

  // ─── Uploads (documents, gallery, cover, media) ───
  async function readUploads(req: FastifyRequest, field: string, max: number) {
    if (!req.isMultipart()) throw Object.assign(new Error("multipart expected"), { statusCode: 415 });
    const files: { spooled: Spooled; filename: string }[] = [];
    const values: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== field || files.length >= max || !part.filename) { part.file.resume(); continue; }
          files.push({ spooled: await spool(storageDir, part.file), filename: safeName(part.filename) });
        } else values[part.fieldname] = String(part.value ?? "");
      }
    } catch (e) {
      await Promise.all(files.map(f => discard(f.spooled)));
      throw e;
    }
    return { files, values };
  }
  async function storePublic(up: { spooled: Spooled; filename: string }, kind: "image" | "any") {
    const type = sniff(up.spooled.head, up.filename);
    const isImage = !!type && type.mime.startsWith("image/");
    if (!type || (kind === "image" && !isImage)) { await discard(up.spooled); return null; }
    const f = await commitFile(db, storageDir, up.spooled, { bucket: "PUBLIC", mime: type.mime, ext: type.ext, originalName: up.filename });
    if (isRaster(f.ext)) await makeVariants(db, storageDir, f).catch(e => app.log.error({ err: e, file: f.id }, "variants failed"));
    return f;
  }

  r.post("/articles/:id/documents", "content.edit", async (req, reply) => {
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    const { files, values } = await readUploads(req, "file", 1);
    if (!files[0]) return reply.code(400).send({ error: "noFile" });
    const f = await storePublic(files[0], "any");
    if (!f) return reply.code(422).send({ error: "fileType" });
    await revise(req, a);
    const pos = (await db.articleDocument.count({ where: { articleId: a.id } }));
    const doc = await db.document.create({
      data: {
        title: clean(values.title) ?? f.originalName.replace(/\.[^.]+$/, ""), fileId: f.id, legacyPath: "", fileName: f.originalName, extension: f.ext,
        size: f.size, uploadedAt: new Date(), articles: { create: { articleId: a.id, position: pos } },
      },
    });
    await db.articleTranslation.updateMany({ where: { articleId: a.id }, data: { documentTitles: await docTitlesOf(a.id) } });
    await audit(req, "document.create", "Document", doc.id, { article: a.id });
    changed();
    return articleDto((await load(a.id))!);
  });

  const DocPatch = z.object({ title: z.string().max(500).nullable(), visible: z.boolean(), position: z.number().int().min(0) }).partial();
  r.patch("/articles/:id/documents/:docId", "content.edit", async (req, reply) => {
    const b = DocPatch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const articleId = Id.parse(req.params.id), documentId = Id.parse(req.params.docId);
    const link = await db.articleDocument.findUnique({ where: { articleId_documentId: { articleId, documentId } } });
    if (!link || !(await load(articleId))) return reply.code(404).send({ error: "notFound" });
    if (b.data.title !== undefined || b.data.visible !== undefined) await db.document.update({ where: { id: documentId }, data: { title: b.data.title === undefined ? undefined : clean(b.data.title), visible: b.data.visible } });
    if (b.data.position !== undefined) await db.articleDocument.update({ where: { articleId_documentId: { articleId, documentId } }, data: { position: b.data.position } });
    await db.articleTranslation.updateMany({ where: { articleId }, data: { documentTitles: await docTitlesOf(articleId) } });
    await audit(req, "document.update", "Document", documentId, { article: articleId, fields: Object.keys(b.data) });
    changed();
    return articleDto((await load(articleId))!);
  });

  r.del("/articles/:id/documents/:docId", "content.edit", async (req, reply) => {
    const articleId = Id.parse(req.params.id), documentId = Id.parse(req.params.docId);
    if (!(await load(articleId))) return reply.code(404).send({ error: "notFound" });
    const del = await db.articleDocument.deleteMany({ where: { articleId, documentId } });
    if (!del.count) return reply.code(404).send({ error: "notFound" });
    // Documents uploaded here go away with their last article; DNN documents stay for their old download links.
    await db.document.deleteMany({ where: { id: documentId, legacyId: null, articles: { none: {} } } });
    await db.articleTranslation.updateMany({ where: { articleId }, data: { documentTitles: await docTitlesOf(articleId) } });
    await audit(req, "document.unlink", "Document", documentId, { article: articleId });
    changed();
    return articleDto((await load(articleId))!);
  });

  r.post("/articles/:id/gallery", "content.edit", async (req, reply) => {
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    const { files } = await readUploads(req, "files", 50);
    let pos = (await db.galleryItem.aggregate({ where: { articleId: a.id }, _max: { position: true } }))._max.position ?? -1;
    const rejected: string[] = [];
    for (const up of files) {
      const f = await storePublic(up, "image");
      if (!f) { rejected.push(up.filename); continue; }
      await db.galleryItem.create({ data: { articleId: a.id, position: ++pos, mediaType: "IMAGE", fileId: f.id, uploadedAt: new Date() } });
    }
    await audit(req, "gallery.add", "Article", a.id, { added: files.length - rejected.length, rejected: rejected.length });
    changed();
    return { ...articleDto((await load(a.id))!), rejected };
  });

  const Embed = z.object({ embedUrl: z.string().url().max(500).refine(u => /^https:\/\/(www\.)?(youtube\.com|youtu\.be|player\.vimeo\.com|vimeo\.com)\//.test(u), "YouTube or Vimeo"), title: z.string().max(300).optional() });
  r.post("/articles/:id/gallery/embed", "content.edit", async (req, reply) => {
    const b = Embed.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    const pos = (await db.galleryItem.aggregate({ where: { articleId: a.id }, _max: { position: true } }))._max.position ?? -1;
    const g = await db.galleryItem.create({ data: { articleId: a.id, position: pos + 1, mediaType: "VIDEO", embedUrl: b.data.embedUrl, title: clean(b.data.title) } });
    await audit(req, "gallery.embed", "GalleryItem", g.id, { article: a.id });
    changed();
    return articleDto((await load(a.id))!);
  });

  const GalleryPatch = z.object({ title: z.string().max(300).nullable(), description: z.string().max(2000).nullable(), visible: z.boolean(), position: z.number().int().min(0) }).partial();
  r.patch("/gallery/:id", "content.edit", async (req, reply) => {
    const b = GalleryPatch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const g = await db.galleryItem.findUnique({ where: { id: Id.parse(req.params.id) } });
    if (!g) return reply.code(404).send({ error: "notFound" });
    await db.galleryItem.update({ where: { id: g.id }, data: { ...b.data, title: b.data.title === undefined ? undefined : clean(b.data.title), description: b.data.description === undefined ? undefined : clean(b.data.description) } });
    await audit(req, "gallery.update", "GalleryItem", g.id, { fields: Object.keys(b.data) });
    changed();
    return { ok: true };
  });

  r.del("/gallery/:id", "content.edit", async (req, reply) => {
    const g = await db.galleryItem.findUnique({ where: { id: Id.parse(req.params.id) } });
    if (!g) return reply.code(404).send({ error: "notFound" });
    await db.galleryItem.delete({ where: { id: g.id } });
    await audit(req, "gallery.remove", "GalleryItem", g.id, { article: g.articleId });
    changed();
    return { ok: true };
  });

  r.post("/articles/:id/cover", "content.edit", async (req, reply) => {
    const a = await load(Id.parse(req.params.id));
    if (!a) return reply.code(404).send({ error: "notFound" });
    const { files } = await readUploads(req, "file", 1);
    if (!files[0]) return reply.code(400).send({ error: "noFile" });
    const f = await storePublic(files[0], "image");
    if (!f) return reply.code(422).send({ error: "fileType" });
    await revise(req, a);
    await db.article.update({ where: { id: a.id }, data: { coverFileId: f.id, updatedAt: new Date() } });
    await audit(req, "article.cover", "Article", a.id, { file: f.id });
    changed();
    return articleDto((await load(a.id))!);
  });

  // ─── Categories and programs ───
  r.get("/categories", [...READ], async () => {
    const [cats, counts] = await Promise.all([
      db.category.findMany({ include: { translations: true }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
      db.articleCategory.groupBy({ by: ["categoryId"], _count: true, where: { article: { deletedAt: null } } }),
    ]);
    const n = new Map(counts.map(c => [c.categoryId, c._count]));
    return cats.map(c => ({ id: c.id, legacyId: c.legacyId, parentId: c.parentId, position: c.position, isActive: c.isActive, color: c.color, articles: n.get(c.id) ?? 0, translations: Object.fromEntries(c.translations.map(t => [t.lang, { name: t.name, slug: t.slug, description: t.description }])) }));
  });
  const CatTr = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional() });
  const Cat = z.object({ parentId: z.number().int().positive().nullable(), position: z.number().int(), isActive: z.boolean(), color: z.string().max(20).nullable(), translations: z.object({ sq: CatTr, en: CatTr.optional() }) });
  const catTr = (id: number, t: Record<string, z.infer<typeof CatTr> | undefined>) =>
    Object.entries(t).filter(([, v]) => v).map(([lang, v]) => ({ categoryId: id, lang: lang as L, name: v!.name.normalize("NFC"), slug: slugify(v!.name), description: clean(v!.description) }));
  r.post("/categories", "content.edit", async (req, reply) => {
    const b = Cat.partial({ position: true, isActive: true, color: true, parentId: true }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const c = await db.category.create({ data: { parentId: b.data.parentId ?? null, position: b.data.position ?? 0, isActive: b.data.isActive ?? true, color: b.data.color ?? null } });
    await db.categoryTranslation.createMany({ data: catTr(c.id, b.data.translations) });
    await audit(req, "category.create", "Category", c.id);
    changed();
    return { id: c.id };
  });
  r.put("/categories/:id", "content.edit", async (req, reply) => {
    const b = Cat.partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const id = Id.parse(req.params.id);
    if (!(await db.category.findUnique({ where: { id } }))) return reply.code(404).send({ error: "notFound" });
    if (b.data.parentId === id) return reply.code(400).send({ error: "invalid" });
    const { translations, ...rest } = b.data;
    await db.category.update({ where: { id }, data: rest });
    if (translations) for (const t of catTr(id, translations)) await db.categoryTranslation.upsert({ where: { categoryId_lang: { categoryId: id, lang: t.lang } }, update: t, create: t });
    await audit(req, "category.update", "Category", id, { fields: Object.keys(b.data) });
    changed();
    return { ok: true };
  });
  r.del("/categories/:id", "content.edit", async (req, reply) => {
    const id = Id.parse(req.params.id);
    const [uses, kids] = await Promise.all([db.articleCategory.count({ where: { categoryId: id } }), db.category.count({ where: { parentId: id } })]);
    if (uses || kids) return reply.code(409).send({ error: "inUse", articles: uses, children: kids });
    const del = await db.category.deleteMany({ where: { id } });
    if (!del.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "category.delete", "Category", id);
    changed();
    return { ok: true };
  });

  const Prog = z.object({ key: z.string().regex(/^[a-z0-9-]{2,40}$/), position: z.number().int(), name: z.object({ sq: z.string().trim().min(1).max(200), en: z.string().trim().max(200).optional() }) });
  r.get("/programs", [...READ], async () => (await db.program.findMany({ include: { translations: true }, orderBy: { position: "asc" } }))
    .map(p => ({ id: p.id, key: p.key, position: p.position, name: Object.fromEntries(p.translations.map(t => [t.lang, t.name])) })));
  const progTr = (id: number, name: Record<string, string | undefined>) => Object.entries(name).filter(([, v]) => v).map(([lang, v]) => ({ programId: id, lang: lang as L, name: v!.normalize("NFC") }));
  r.post("/programs", "content.edit", async (req, reply) => {
    const b = Prog.partial({ position: true }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    if (await db.program.findUnique({ where: { key: b.data.key } })) return reply.code(409).send({ error: "exists" });
    const p = await db.program.create({ data: { key: b.data.key, position: b.data.position ?? 0 } });
    await db.programTranslation.createMany({ data: progTr(p.id, b.data.name) });
    await audit(req, "program.create", "Program", p.id);
    changed();
    return { id: p.id };
  });
  r.put("/programs/:id", "content.edit", async (req, reply) => {
    const b = Prog.omit({ key: true }).partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const id = Id.parse(req.params.id);
    if (!(await db.program.findUnique({ where: { id } }))) return reply.code(404).send({ error: "notFound" });
    if (b.data.position !== undefined) await db.program.update({ where: { id }, data: { position: b.data.position } });
    if (b.data.name) for (const t of progTr(id, b.data.name)) await db.programTranslation.upsert({ where: { programId_lang: { programId: id, lang: t.lang } }, update: t, create: t });
    await audit(req, "program.update", "Program", id);
    changed();
    return { ok: true };
  });

  // ─── HTML blocks (DNN HTML module, with version history) ───
  r.get("/html-blocks", [...READ], async req => {
    const q = req.query as Record<string, string>;
    const where: Prisma.HtmlBlockWhereInput = {};
    if (q.lang === "sq" || q.lang === "en") where.lang = q.lang;
    if (q.page) where.pageKey = q.page === "site" ? null : q.page;
    if (q.live === "1") where.isLive = true;
    const rows = await db.htmlBlock.findMany({ where, orderBy: [{ pageKey: "asc" }, { pane: "asc" }, { position: "asc" }, { id: "asc" }], include: { _count: { select: { revisions: true } } } });
    return rows.map(b => ({ id: b.id, key: b.key, lang: b.lang, title: b.title, pageKey: b.pageKey, pane: b.pane, position: b.position, isLive: b.isLive, updatedAt: b.updatedAt, revisions: b._count.revisions, excerpt: toText(b.html).slice(0, 160) }));
  });
  r.get("/html-blocks/:id", [...READ], async (req, reply) => {
    const b = await db.htmlBlock.findUnique({ where: { id: Id.parse(req.params.id) }, include: { revisions: { orderBy: { version: "desc" }, select: { id: true, version: true, createdAt: true, createdById: true, isPublished: true } } } });
    return b ?? reply.code(404).send({ error: "notFound" });
  });
  r.get("/html-blocks/:id/revisions/:rev", [...READ], async (req, reply) => {
    const rev = await db.htmlBlockRevision.findFirst({ where: { id: Id.parse(req.params.rev), blockId: Id.parse(req.params.id) } });
    return rev ?? reply.code(404).send({ error: "notFound" });
  });
  const Block = z.object({ html: z.string().max(1_000_000), title: z.string().max(300).nullable().optional() });
  async function saveBlock(req: FastifyRequest, id: number, html: string, title: string | null | undefined, action: string, meta: Record<string, unknown> = {}) {
    const b = await db.htmlBlock.findUnique({ where: { id } });
    if (!b) return { status: 404 as const };
    if (!canEditLang(req, b.lang)) return { status: 403 as const };
    const clean_ = sanitize(html);
    const version = ((await db.htmlBlockRevision.aggregate({ where: { blockId: id }, _max: { version: true } }))._max.version ?? 0) + 1;
    await db.$transaction([
      db.htmlBlock.update({ where: { id }, data: { html: clean_, title: title === undefined ? undefined : clean(title), updatedAt: new Date() } }),
      db.htmlBlockRevision.create({ data: { blockId: id, version, html: clean_, createdById: req.admin!.user.id } }),
    ]);
    await audit(req, action, "HtmlBlock", id, { version, ...meta });
    changed();
    return { status: 200 as const, version };
  }
  r.put("/html-blocks/:id", [...READ], async (req, reply) => {
    const b = Block.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const res = await saveBlock(req, Id.parse(req.params.id), b.data.html, b.data.title, "htmlblock.update");
    return res.status === 200 ? { ok: true, version: res.version } : reply.code(res.status).send({ error: res.status === 404 ? "notFound" : "forbidden" });
  }, big);
  r.post("/html-blocks/:id/revisions/:rev/restore", [...READ], async (req, reply) => {
    const rev = await db.htmlBlockRevision.findFirst({ where: { id: Id.parse(req.params.rev), blockId: Id.parse(req.params.id) } });
    if (!rev) return reply.code(404).send({ error: "notFound" });
    const res = await saveBlock(req, rev.blockId, rev.html, undefined, "htmlblock.restore", { from: rev.version });
    return res.status === 200 ? { ok: true, version: res.version } : reply.code(res.status).send({ error: res.status === 404 ? "notFound" : "forbidden" });
  });

  // ─── Media (public files; DNN file manager) ───
  r.get("/media", "content.edit", async req => {
    const q = req.query as Record<string, string>;
    const pg = page(q, 200);
    const where: Prisma.FileWhereInput = { bucket: "PUBLIC" };
    if (q.type === "image") where.mime = { startsWith: "image/" };
    if (q.type === "document") where.NOT = { mime: { startsWith: "image/" } };
    if (q.q) where.originalName = { contains: q.q, mode: "insensitive" };
    const [total, rows] = await Promise.all([db.file.count({ where }), db.file.findMany({ where, orderBy: { id: "desc" }, take: pg.take, skip: pg.skip, include: { variants: { select: { kind: true } } } })]);
    return { total, page: pg.page, pageSize: pg.pageSize, items: rows.map(f => ({ id: f.id, name: f.originalName, mime: f.mime, size: Number(f.size), width: f.width, height: f.height, createdAt: f.createdAt, url: fileUrl(f), thumb: f.variants.some(v => v.kind === "w400") ? fileUrl(f, "w400") : null })) };
  });
  r.post("/media", "content.edit", async (req, reply) => {
    const { files } = await readUploads(req, "files", 50);
    const out: { id: number; name: string; url: string }[] = [], rejected: string[] = [];
    for (const up of files) {
      const f = await storePublic(up, "any");
      if (f) out.push({ id: f.id, name: f.originalName, url: fileUrl(f) }); else rejected.push(up.filename);
    }
    await audit(req, "media.upload", "File", null, { added: out.length, rejected: rejected.length });
    return reply.send({ items: out, rejected });
  });
  r.del("/media/:id", "content.edit", async (req, reply) => {
    const id = Id.parse(req.params.id);
    const f = await db.file.findFirst({ where: { id, bucket: "PUBLIC" }, include: { _count: { select: { coverOf: true, documents: true, gallery: true, legacyPaths: true } } } });
    if (!f) return reply.code(404).send({ error: "notFound" });
    const like = `%/files/${id}/%`;
    const [inText] = await db.$queryRaw<{ n: bigint }[]>`SELECT (SELECT count(*) FROM "ArticleTranslation" WHERE "bodyHtml" LIKE ${like} OR summary LIKE ${like}) + (SELECT count(*) FROM "HtmlBlock" WHERE html LIKE ${like}) AS n`;
    const uses = f._count.coverOf + f._count.documents + f._count.gallery + f._count.legacyPaths + Number(inText.n);
    // Files used by an article or a text block, or reachable at an old /Portals URL, stay.
    if (uses) return reply.code(409).send({ error: "inUse", uses: { ...f._count, inText: Number(inText.n) } });
    await db.file.delete({ where: { id } });
    await audit(req, "media.delete", "File", id);
    return { ok: true };
  });
}
