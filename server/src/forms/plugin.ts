// Public form endpoints: the School of Politics application (DigForm) and the contact form (DNN Feedback).
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { keyringFromEnv } from "../lib/crypto.js";
import { createMailer } from "../lib/mailer.js";
import { paths } from "../lib/paths.js";
import { safeName, spool } from "../lib/storage.js";
import { HONEYPOT, checkToken, issueToken, looksLikeSpam } from "../lib/antispam.js";
import { APPLY_FORM, currentNotice, formDto, loadForm } from "./definition.js";
import { discardAll, sendActions, store, validate, type Incoming } from "./submit.js";

const MAX_FILE = 10 * 1024 * 1024;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Visibility = "required" | "optional" | "hidden";
interface ContactSettings { sendTo: string | null; maxMessage: number; fields: Record<"name" | "email" | "street" | "telephone" | "subject" | "message", Visibility> }

async function contactSettings(db: PrismaClient, lang: string): Promise<ContactSettings> {
  const row = await db.setting.findUnique({ where: { key: "contact.settings" } });
  const all = (row?.value ?? {}) as unknown as Record<string, ContactSettings>;
  return all[lang] ?? all.sq ?? { sendTo: null, maxMessage: 1000, fields: { name: "required", email: "required", street: "optional", telephone: "optional", subject: "optional", message: "required" } };
}

/** Extra page data for pages that carry a form (embedded by the site renderer). */
export async function pageForms(app: FastifyInstance, pageKey: string, lang: "sq" | "en") {
  const { db, config } = app;
  if (pageKey === "apply") {
    const form = await loadForm(db, APPLY_FORM[lang]);
    if (!form) return {};
    return { form: await formDto(db, form), formToken: issueToken(config.SESSION_SECRET, form.key) };
  }
  if (pageKey === "contact") {
    const s = await contactSettings(db, lang);
    return { contact: { fields: s.fields, maxMessage: s.maxMessage }, formToken: issueToken(config.SESSION_SECRET, "contact") };
  }
  return {};
}

export async function formsPlugin(app: FastifyInstance) {
  const { db, config } = app;
  const { storageDir } = paths(config);
  const ring = keyringFromEnv();
  const mailer = createMailer(config);
  await app.register(multipart, { limits: { fileSize: MAX_FILE, files: 10, fields: 200, fieldSize: 64 * 1024, parts: 220 } });

  app.get<{ Params: { key: string } }>("/api/public/forms/:key", async (req, reply) => {
    const form = await loadForm(db, req.params.key);
    if (!form) return reply.code(404).send({ error: "notFound" });
    reply.header("Cache-Control", "no-store");
    return { ...(await formDto(db, form)), token: issueToken(config.SESSION_SECRET, form.key) };
  });

  app.post<{ Params: { key: string } }>("/api/public/forms/:key/submissions", { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req, reply) => {
    const form = await loadForm(db, req.params.key);
    if (!form) return reply.code(404).send({ error: "notFound" });
    if (!form.isOpen) return reply.code(410).send({ error: "closed" });
    if (!req.isMultipart()) return reply.code(415).send({ error: "multipart" });

    const fileFields = new Set(form.fields.filter(f => f.type === "FILE").map(f => f.code));
    const input: Incoming = { values: new Map(), files: new Map() };
    let current = "";
    try {
      for await (const part of req.parts()) {
        current = part.fieldname;
        if (part.type === "file") {
          if (!fileFields.has(part.fieldname) || input.files.has(part.fieldname) || !part.filename) { part.file.resume(); continue; }
          input.files.set(part.fieldname, { spooled: await spool(storageDir, part.file), filename: safeName(part.filename) });
        } else if (!input.values.has(part.fieldname)) input.values.set(part.fieldname, String(part.value ?? ""));
      }
    } catch (e) {
      await discardAll(input);
      if (e instanceof app.multipartErrors.RequestFileTooLargeError) return reply.code(413).send({ error: "invalid", errors: { [current]: "fileSize" } });
      if (e instanceof app.multipartErrors.FilesLimitError || e instanceof app.multipartErrors.FieldsLimitError || e instanceof app.multipartErrors.PartsLimitError) return reply.code(400).send({ error: "tooManyParts" });
      throw e;
    }

    // Bots fill the hidden field: answer as if it worked, store nothing.
    if (input.values.get(HONEYPOT)) { await discardAll(input); return { ok: true, ref: null }; }
    const tok = checkToken(config.SESSION_SECRET, form.key, input.values.get("_t"));
    if (tok !== "ok") { await discardAll(input); return reply.code(400).send({ error: tok === "too-fast" ? "tooFast" : "expired" }); }
    const notice = await currentNotice(db, form);
    if (notice && (input.values.get("_consent") !== "1" || Number(input.values.get("_notice")) !== notice.id)) {
      await discardAll(input);
      return reply.code(400).send({ error: "consent" });
    }
    const v = validate(form, input);
    if (!v.ok) { await discardAll(input); return reply.code(422).send({ error: "invalid", errors: v.errors }); }

    const sub = await store(db, ring, storageDir, form, v.checked, { noticeId: notice?.id ?? null });
    req.log.info({ form: form.key, submission: sub.id }, "form submission stored");
    void sendActions(db, mailer, config.PUBLIC_BASE_URL, form, v.checked, sub.id, e => req.log.error({ err: e, submission: sub.id }, "form email failed"));
    const s = (form.settings ?? {}) as { thankYouHtml?: string | null };
    return { ok: true, ref: sub.id, thankYouHtml: s.thankYouHtml ?? null };
  });

  const Contact = z.object({
    lang: z.enum(["sq", "en"]).default("sq"),
    name: z.string().max(200).default(""), email: z.string().max(254).default(""),
    telephone: z.string().max(50).default(""), street: z.string().max(200).default(""),
    subject: z.string().max(200).default(""), message: z.string().max(20000).default(""),
    [HONEYPOT]: z.string().max(500).optional(), _t: z.string().max(200).optional(),
  });

  app.post("/api/public/contact", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const parsed = Contact.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid" });
    const b = parsed.data;
    if (b[HONEYPOT]) return { ok: true };
    const tok = checkToken(config.SESSION_SECRET, "contact", b._t);
    if (tok !== "ok") return reply.code(400).send({ error: tok === "too-fast" ? "tooFast" : "expired" });

    const s = await contactSettings(db, b.lang);
    const val = { name: b.name, email: b.email, telephone: b.telephone, street: b.street, subject: b.subject, message: b.message };
    const errors: Record<string, string> = {};
    for (const [k, vis] of Object.entries(s.fields) as [keyof typeof val, Visibility][]) {
      val[k] = vis === "hidden" ? "" : val[k].normalize("NFC").trim();
      if (vis === "required" && !val[k]) errors[k] = "required";
    }
    if (val.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val.email)) errors.email = "email";
    if (val.message.length > s.maxMessage) errors.message = "tooLong";
    if (Object.keys(errors).length) return reply.code(422).send({ error: "invalid", errors });

    const spamFlag = looksLikeSpam(val.subject, val.message);
    const msg = await db.contactMessage.create({
      data: { lang: b.lang, name: val.name || null, email: val.email.toLowerCase(), phone: val.telephone || null, street: val.street || null, subject: val.subject || null, message: val.message, spamFlag },
    });
    await db.auditLog.create({ data: { action: "contact.create", entityType: "ContactMessage", entityId: String(msg.id), meta: { spamFlag } } });
    // DNN sent every message to the module's "Send to" address; flagged spam stays in the inbox without an email.
    if (s.sendTo && !spamFlag) {
      const rows = ([["Emri", val.name], ["Email", val.email], ["Telefoni", val.telephone], ["Adresa", val.street], ["Tema", val.subject]] as const)
        .filter(([, v]) => v).map(([k, v]) => `<tr><td style="color:#555">${k}</td><td>${esc(v)}</td></tr>`).join("");
      void mailer.send({
        to: s.sendTo.split(/[,;]/).map(x => x.trim()).filter(Boolean), replyTo: val.email,
        subject: `PIPS: ${val.subject || (b.lang === "en" ? "Message from the website" : "Mesazh nga faqja")}`,
        html: `<table cellpadding="6" style="font:14px/1.4 sans-serif">${rows}</table><p style="white-space:pre-wrap;font:14px/1.5 sans-serif">${esc(val.message)}</p>`,
      }).catch(e => req.log.error({ err: e, contact: msg.id }, "contact email failed"));
    }
    return { ok: true };
  });
}
