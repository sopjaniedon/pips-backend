// Validation and storage of a public form submission (DigForm parity + consent and encryption).
import type { FormField, Prisma, PrismaClient } from "@prisma/client";
import { encryptField, valueAad, type Keyring } from "../lib/crypto.js";
import { commitFile, discard, type Spooled } from "../lib/storage.js";
import { accepts, sniff, type Sniffed } from "../lib/sniff.js";
import { isRaster, makeVariants } from "../lib/images.js";
import type { Mailer } from "../lib/mailer.js";
import type { FormWithFields } from "./definition.js";

export interface Upload { spooled: Spooled; filename: string }
export interface Incoming { values: Map<string, string>; files: Map<string, Upload> }
export type Errors = Record<string, string>; // field code → message key

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const prop = (f: FormField, k: string) => ((f.properties ?? {}) as Record<string, string>)[k] ?? "";

function validDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && +m[1] >= 1900 && +m[1] <= 2100;
}

export interface Checked { text: Map<number, string>; files: Map<number, Upload & { type: Sniffed }> }

/** Field-by-field check. Error values are message keys the page translates (required, email, date, …). */
export function validate(form: FormWithFields, input: Incoming): { ok: true; checked: Checked } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const text = new Map<number, string>();
  const files = new Map<number, Upload & { type: Sniffed }>();
  for (const f of form.fields) {
    if (f.type === "HEADING") continue;
    if (f.type === "FILE") {
      const up = input.files.get(f.code);
      if (!up || up.spooled.size === 0) { if (f.required) errors[f.code] = "required"; continue; }
      const type = sniff(up.spooled.head, up.filename);
      if (!type || (prop(f, "FP_ValidateFileExtension") !== "0" && !accepts(prop(f, "FP_FileExtension"), type.mime))) { errors[f.code] = "fileType"; continue; }
      files.set(f.id, { ...up, type });
      continue;
    }
    const v = (input.values.get(f.code) ?? "").normalize("NFC").trim();
    if (!v) { if (f.required) errors[f.code] = "required"; continue; }
    const max = Number(prop(f, "FP_MaxLength")) || (f.type === "TEXTAREA" ? 10000 : 500);
    if (v.length > max) { errors[f.code] = "tooLong"; continue; }
    if (f.type === "EMAIL" && (!EMAIL.test(v) || v.length > 254)) { errors[f.code] = "email"; continue; }
    if (f.type === "DATE" && !validDate(v)) { errors[f.code] = "date"; continue; }
    if ((f.type === "DROPDOWN" || f.type === "RADIO") && !((f.options as string[] | null) ?? []).includes(v)) { errors[f.code] = "option"; continue; }
    const re = prop(f, "FP_ValidateRegEx");
    if (re) { try { if (!new RegExp(re).test(v)) { errors[f.code] = "format"; continue; } } catch { /* .NET-only pattern: skip */ } }
    text.set(f.id, v);
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, checked: { text, files } };
}

export async function discardAll(input: Incoming) {
  await Promise.all([...input.files.values()].map(u => discard(u.spooled)));
}

/** Stores files (private bucket), then the submission and its values in one transaction. */
export async function store(db: PrismaClient, ring: Keyring, storageDir: string, form: FormWithFields, checked: Checked, consent: { noticeId: number | null }) {
  const fileIds = new Map<number, { fileId: number; name: string }>();
  for (const [fieldId, up] of checked.files) {
    const name = up.filename;
    const file = await commitFile(db, storageDir, up.spooled, { bucket: "PRIVATE", mime: up.type.mime, ext: up.type.ext, originalName: name });
    fileIds.set(fieldId, { fileId: file.id, name });
    // Small private thumbnail for the admin (photos can be large or HEIC, which browsers can't show).
    if (isRaster(file.ext)) void makeVariants(db, storageDir, file).catch(() => undefined);
  }
  return db.$transaction(async tx => {
    const now = new Date();
    const sub = await tx.submission.create({
      data: { formId: form.id, lang: form.lang, consentNoticeId: consent.noticeId, consentAt: now, consentSource: "FORM", createdAt: now, updatedAt: now },
    });
    const rows: Prisma.SubmissionValueCreateManyInput[] = [];
    for (const f of form.fields) {
      const row: Prisma.SubmissionValueCreateManyInput = { submissionId: sub.id, fieldId: f.id };
      const file = fileIds.get(f.id);
      const v = checked.text.get(f.id);
      if (file) { row.fileId = file.fileId; row.valueText = file.name; }
      else if (v == null) continue;
      else if (f.sensitivity === "ENCRYPTED") { const e = encryptField(ring, v, valueAad(sub.id, f.id)); row.valueEnc = new Uint8Array(e.enc); row.encKid = e.kid; }
      else if (f.type === "DATE") row.valueDate = new Date(`${v}T00:00:00Z`);
      else row.valueText = v;
      rows.push(row);
    }
    await tx.submissionValue.createMany({ data: rows });
    await tx.auditLog.create({ data: { action: "submission.create", entityType: "Submission", entityId: String(sub.id), meta: { form: form.key, values: rows.length, files: fileIds.size } } });
    return sub;
  });
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const label = (f: FormField) => f.label.replace(/\s*\*\s*$/, "");

/**
 * Runs the form's enabled email actions (DigForm "submit actions"). NOTIFY goes to PIPS with the answers, but
 * encrypted fields are never written into an email and files are only named. CONFIRM goes to the applicant
 * and contains only the configured text ([Code] tokens may use non-encrypted text fields).
 */
export async function sendActions(db: PrismaClient, mailer: Mailer, baseUrl: string, form: FormWithFields, checked: Checked, submissionId: number, log: (e: unknown) => void) {
  const actions = await db.formEmailAction.findMany({ where: { formId: form.id, enabled: true } });
  if (!actions.length) return 0;
  const byCode = new Map(form.fields.map(f => [f.code, f]));
  const valueOf = (f: FormField) => checked.text.get(f.id) ?? (checked.files.get(f.id)?.filename ?? "");
  const tokens = (html: string) => html.replace(/\[([\p{L}\w]+)\]/gu, (m, code: string) => {
    const f = byCode.get(code);
    return f && f.sensitivity !== "ENCRYPTED" && f.type !== "FILE" ? escHtml(valueOf(f)) : f ? "" : m;
  });
  const table = () => `<table cellpadding="6" style="border-collapse:collapse;font:14px/1.4 sans-serif">${form.fields.map(f => {
    if (f.type === "HEADING") return `<tr><td colspan="2" style="padding-top:16px"><b>${escHtml(label(f))}</b></td></tr>`;
    const v = f.sensitivity === "ENCRYPTED" ? (checked.text.has(f.id) ? "•••• (e enkriptuar, shiheni në panel)" : "") : valueOf(f);
    return `<tr><td style="color:#555;vertical-align:top">${escHtml(label(f))}</td><td>${escHtml(v)}</td></tr>`;
  }).join("")}</table>`;
  const adminLink = `${baseUrl.replace(/\/$/, "")}/admin/#/applications/${submissionId}`;
  let sent = 0;
  for (const a of actions) {
    try {
      if (a.kind === "NOTIFY") {
        const to = (a.toAddresses ?? "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
        if (!to.length) continue;
        const replyTo = form.fields.find(f => f.type === "EMAIL" && checked.text.has(f.id));
        await mailer.send({
          to, subject: a.subject, replyTo: replyTo ? checked.text.get(replyTo.id) : undefined,
          html: `${tokens(a.bodyHtml)}<p>${escHtml(form.title)} · nr. ${submissionId}</p>${table()}<p><a href="${adminLink}">${escHtml(adminLink)}</a></p>`,
        });
      } else {
        const f = a.toFieldCode ? byCode.get(a.toFieldCode) : null;
        const to = f ? checked.text.get(f.id) : null;
        if (!to) continue;
        await mailer.send({ to, subject: a.subject, html: tokens(a.bodyHtml) });
      }
      sent++;
    } catch (e) { log(e); }
  }
  return sent;
}
