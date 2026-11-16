import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { clean } from "../lib/text.js";
import type { Counts, Step } from "./types.js";

const SPAM_WORDS = /\b(casino|viagra|cialis|crypto|bitcoin|forex|loan|porn|sex|seo services|backlinks|escort|betting|essay writing)\b/i;

export const contactStep: Step = {
  id: "17",
  name: "contact messages + form settings (DNN Feedback); spam flagged, nothing deleted; IPs/user agents not migrated",
  async run() {
    const rows = await select<{ FeedbackID: number; ModuleID: number; Status: number; Subject: string | null; SenderEmail: string; Message: string; SenderName: string | null; SenderStreet: string | null; SenderCity: string | null; SenderCountry: string | null; SenderTelephone: string | null; CreatedOnDate: Date }>(
      "SELECT FeedbackID, ModuleID, Status, Subject, SenderEmail, Message, SenderName, SenderStreet, SenderCity, SenderCountry, SenderTelephone, CreatedOnDate FROM Feedback",
    );
    let spam = 0;
    for (const r of rows) {
      const links = (r.Message.match(/https?:\/\//gi) ?? []).length;
      const spamFlag = links >= 2 || SPAM_WORDS.test(`${r.Subject ?? ""} ${r.Message}`);
      if (spamFlag) spam++;
      const data = {
        lang: r.ModuleID === 2270 ? ("en" as const) : ("sq" as const), legacyModuleId: r.ModuleID,
        name: clean(r.SenderName), email: r.SenderEmail.trim().toLowerCase(), phone: clean(r.SenderTelephone), street: clean(r.SenderStreet),
        city: clean(r.SenderCity), country: clean(r.SenderCountry), subject: clean(r.Subject), message: r.Message.normalize("NFC"),
        legacyStatus: r.Status, spamFlag, createdAt: r.CreatedOnDate,
      };
      await db.contactMessage.upsert({ where: { legacyId: r.FeedbackID }, update: data, create: { ...data, legacyId: r.FeedbackID } });
    }
    // Form settings of the two Feedback modules (1428 sq, 2270 en): recipient, field visibility, message limit.
    const settings = await select<{ ModuleID: number; SettingName: string; SettingValue: string }>(
      "SELECT ModuleID, SettingName, SettingValue FROM ModuleSettings WHERE ModuleID IN (1428, 2270) AND SettingName LIKE 'Feedback[_]%'",
    );
    const contact: Record<string, unknown> = {};
    for (const [moduleId, lang] of [[1428, "sq"], [2270, "en"]] as const) {
      const s = (n: string) => settings.find(x => x.ModuleID === moduleId && x.SettingName === `Feedback_${n}`)?.SettingValue;
      const vis = (n: string) => (s(`${n}FieldVisibility`) ?? "Hidden").toLowerCase(); // required | optional | hidden
      contact[lang] = {
        sendTo: s("SendTo") ?? null, sendCopy: s("SendCopy") === "True", maxMessage: Number(s("MaxMessage") ?? 1000),
        fields: { name: vis("Name"), email: vis("Email"), street: vis("Street"), city: vis("City"), country: vis("Country"), telephone: vis("Telephone"), message: vis("Message"), subject: "optional" },
        captcha: s("CaptchaVisibility") ?? "Disabled", moderated: s("Moderated") === "True",
      };
    }
    await db.setting.upsert({ where: { key: "contact.settings" }, update: { value: contact as object }, create: { key: "contact.settings", value: contact as object } });
    return { contactMessages: rows.length, spamFlagged: spam };
  },
};

export const finalizeStep: Step = {
  id: "18",
  name: "finalise: attach document titles to translations and rebuild the search index",
  async run() {
    await db.$executeRawUnsafe(`UPDATE "ArticleTranslation" SET "documentTitles" = ''`);
    const n = await db.$executeRawUnsafe(`
      UPDATE "ArticleTranslation" t SET "documentTitles" = sub.titles
      FROM (SELECT ad."articleId", string_agg(coalesce(d.title, d."fileName"), ' ' ORDER BY ad.position) AS titles
            FROM "ArticleDocument" ad JOIN "Document" d ON d.id = ad."documentId" GROUP BY ad."articleId") sub
      WHERE sub."articleId" = t."articleId"`);
    await db.$executeRawUnsafe(`UPDATE "ArticleTranslation" SET title = title`); // fires the search trigger for every row
    const indexed = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM "ArticleTranslation" WHERE search IS NOT NULL`);
    return { translationsWithDocuments: n, searchIndexed: Number(indexed[0].n) };
  },
};

const one = async (q: string) => Number((await select<{ n: number }>(q))[0].n);
const pg = async (q: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(q))[0].n);

export const verifyStep: Step = {
  id: "19",
  name: "verify against the legacy database (any mismatch fails the run)",
  async run() {
    const checks: [string, number, number][] = [
      ["articles", await one("SELECT COUNT(*) n FROM EasyDNNNews WHERE PortalID = 0"), await pg(`SELECT count(*) n FROM "Article" WHERE "legacyId" IS NOT NULL`)],
      ["translationsEn", await one("SELECT COUNT(*) n FROM EasyDNNNewsContentLocalization WHERE LocaleCode = 'en-GB'"), await pg(`SELECT count(*) n FROM "ArticleTranslation" WHERE lang = 'en'`)],
      ["categories", await one("SELECT COUNT(*) n FROM EasyDNNNewsCategoryList"), await pg(`SELECT count(*) n FROM "Category"`)],
      ["articleCategories", await one("SELECT COUNT(*) n FROM (SELECT DISTINCT ArticleID, CategoryID FROM EasyDNNNewsCategories) x"), await pg(`SELECT count(*) n FROM "ArticleCategory"`)],
      ["articlePrograms", await one("SELECT COUNT(*) n FROM EasyDNNfieldsMultiSelected WHERE CustomFieldID = 3"), await pg(`SELECT count(*) n FROM "ArticleProgram"`)],
      ["articlesWithYear", await one("SELECT COUNT(DISTINCT ArticleID) n FROM EasyDNNfieldsMultiSelected WHERE CustomFieldID = 4"), await pg(`SELECT count(*) n FROM "Article" WHERE "publicationYear" IS NOT NULL`)],
      ["documents", await one("SELECT COUNT(*) n FROM EasyDNNNewsDocuments"), await pg(`SELECT count(*) n FROM "Document"`)],
      ["documentLinks", await one("SELECT COUNT(*) n FROM EasyDNNNewsDocumentItems"), await pg(`SELECT count(*) n FROM "ArticleDocument"`)],
      ["galleryItems", await one("SELECT COUNT(*) n FROM EasyGalleryPictures"), await pg(`SELECT count(*) n FROM "GalleryItem"`)],
      ["articleRevisions", await one("SELECT COUNT(*) n FROM EasyDNNNewsArchive a WHERE EXISTS (SELECT 1 FROM EasyDNNNews n WHERE n.ArticleID = a.ArticleID AND n.PortalID = 0)"), await pg(`SELECT count(*) n FROM "ArticleRevision" WHERE "legacyId" > 0`)],
      ["htmlModules", await one("SELECT COUNT(DISTINCT ModuleID) n FROM HtmlText"), await pg(`SELECT count(*) n FROM "HtmlBlock"`)],
      ["htmlVersions", await one("SELECT COUNT(*) n FROM HtmlText"), await pg(`SELECT count(*) n FROM "HtmlBlockRevision"`)],
      ["legacyUrls", await one("SELECT COUNT(*) n FROM EasyDNNnewsUrlNewProviderData"), await pg(`SELECT count(*) n FROM "LegacyUrl"`)],
      ["contactMessages", await one("SELECT COUNT(*) n FROM Feedback"), await pg(`SELECT count(*) n FROM "ContactMessage"`)],
      ["users", await one("SELECT COUNT(*) n FROM Users"), await pg(`SELECT count(*) n FROM "User" WHERE "legacyId" IS NOT NULL`)],
    ];
    const out: Counts = {};
    const bad: string[] = [];
    for (const [k, src, dst] of checks) {
      out[`${k}.source`] = src; out[`${k}.target`] = dst;
      if (src !== dst) bad.push(`${k}: source ${src} ≠ target ${dst}`);
    }
    if (bad.length) throw new Error("verification failed:\n  " + bad.join("\n  "));
    return out;
  },
};

/** Content digest of the imported tables: equal digests across two runs prove the import is re-runnable without changes. */
export async function digest(): Promise<Record<string, string>> {
  const tables: Record<string, string> = {
    Article: `SELECT md5(string_agg(row(a."legacyId", a.status, a."publishAt", a."expireAt", a.featured, a."detailType", a."linkUrl", a."legacyCoverPath", a."publicationYear", a."analyticalType", a."viewCount", a."authorId")::text, '|' ORDER BY a."legacyId") ) d FROM "Article" a`,
    ArticleTranslation: `SELECT md5(string_agg(row(a."legacyId", t.lang, t.title, t.subtitle, t.summary, t."bodyHtml", t.slug, t."documentTitles")::text, '|' ORDER BY a."legacyId", t.lang)) d FROM "ArticleTranslation" t JOIN "Article" a ON a.id = t."articleId"`,
    ArticleCategory: `SELECT md5(string_agg(row(a."legacyId", c."legacyId")::text, '|' ORDER BY a."legacyId", c."legacyId")) d FROM "ArticleCategory" x JOIN "Article" a ON a.id = x."articleId" JOIN "Category" c ON c.id = x."categoryId"`,
    Document: `SELECT md5(string_agg(row("legacyId", title, "legacyPath", "downloadCount")::text, '|' ORDER BY "legacyId")) d FROM "Document"`,
    GalleryItem: `SELECT md5(string_agg(row("legacyId", "legacyPath", visible, position)::text, '|' ORDER BY "legacyId")) d FROM "GalleryItem"`,
    HtmlBlock: `SELECT md5(string_agg(row(key, lang, html, "pageKey", "isLive")::text, '|' ORDER BY key)) d FROM "HtmlBlock"`,
    Redirect: `SELECT md5(string_agg(row("fromPath", "toPath")::text, '|' ORDER BY "fromPath")) d FROM "Redirect"`,
    ContactMessage: `SELECT md5(string_agg(row("legacyId", email, message, "spamFlag")::text, '|' ORDER BY "legacyId")) d FROM "ContactMessage"`,
  };
  const out: Record<string, string> = {};
  for (const [k, q] of Object.entries(tables)) out[k] = (await db.$queryRawUnsafe<{ d: string }[]>(q))[0].d;
  return out;
}
