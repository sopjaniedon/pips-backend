// Applications admin (DigForm parity): results grid, view, edit, print, export, delete, statistics, field builder,
// settings and submit actions. Encrypted (passport) values are only decrypted on "reveal" or a sensitive export,
// both of which need a reason and are audited, like every view of an application.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { FormField, Prisma, SubmissionValue } from "@prisma/client";
import { decryptField, encryptField, keyringFromEnv, valueAad } from "../lib/crypto.js";
import { paths } from "../lib/paths.js";
import { clean, sanitize } from "../lib/html.js";
import { validate, type Incoming } from "../forms/submit.js";
import { buildSteps } from "../forms/definition.js";
import { audit, has, page, routes } from "./registry.js";

const Id = z.coerce.number().int().positive();
const label = (f: FormField) => f.label.replace(/\s*\*\s*$/, "").replace(/​/g, "").trim();
const Reason = z.string().trim().min(5).max(500);

type ValueRow = SubmissionValue & { file?: { id: number; originalName: string; mime: string; size: bigint } | null };
function display(f: FormField, v: ValueRow | undefined, subId: number) {
  if (!v) return null;
  if (f.sensitivity === "ENCRYPTED") return v.valueEnc ? { encrypted: true } : null;
  if (f.type === "FILE") return v.fileId ? { file: { name: v.valueText ?? v.file?.originalName ?? "file", mime: v.file?.mime ?? null, size: v.file ? Number(v.file.size) : null, url: `/api/admin/submissions/${subId}/files/${f.id}` } } : v.valueText ? { file: { name: v.valueText, missing: true } } : null;
  if (f.type === "DATE") return v.valueDate ? v.valueDate.toISOString().slice(0, 10) : (v.valueText || null);
  return v.valueText ?? (v.valueNumber != null ? String(v.valueNumber) : null);
}
const plainOf = (f: FormField, v: ValueRow | undefined) =>
  !v ? "" : f.type === "DATE" ? (v.valueDate ? v.valueDate.toISOString().slice(0, 10) : v.valueText ?? "") : f.type === "FILE" ? (v.valueText ?? "") : (v.valueText ?? "");

export async function formsAdminRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const { storageDir } = paths(config);
  const ring = keyringFromEnv();
  const r = routes(app, "/api/admin");
  const VIEW = ["applications.view", "forms.manage"] as const;
  const loadForm = (id: number) => db.form.findUnique({ where: { id }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
  const loadSub = (id: number) => db.submission.findFirst({ where: { id, deletedAt: null }, include: { form: { include: { fields: { orderBy: { sortOrder: "asc" } } } }, values: { include: { file: { select: { id: true, originalName: true, mime: true, size: true } } } }, consentNotice: true } });
  const decrypt = (subId: number, f: FormField, v: ValueRow) => decryptField(ring, v.valueEnc!, v.encKid!, valueAad(subId, f.id));

  // ─── Forms ───
  r.get("/forms", [...VIEW], async () => {
    const [forms, counts] = await Promise.all([
      db.form.findMany({ orderBy: { id: "asc" } }),
      db.submission.groupBy({ by: ["formId"], where: { deletedAt: null }, _count: true, _max: { createdAt: true } }),
    ]);
    return forms.map(f => { const c = counts.find(x => x.formId === f.id); return { id: f.id, key: f.key, title: f.title, lang: f.lang, isOpen: f.isOpen, isBackup: f.isBackup, submissions: c?._count ?? 0, lastSubmissionAt: c?._max.createdAt ?? null }; });
  });

  r.get("/forms/:id", [...VIEW], async (req, reply) => {
    const f = await db.form.findUnique({ where: { id: Id.parse(req.params.id) }, include: { fields: { orderBy: { sortOrder: "asc" }, include: { _count: { select: { values: true } } } }, actions: { orderBy: { id: "asc" } }, notices: { orderBy: [{ lang: "asc" }, { version: "desc" }] } } });
    if (!f) return reply.code(404).send({ error: "notFound" });
    return {
      id: f.id, key: f.key, title: f.title, lang: f.lang, isOpen: f.isOpen, isBackup: f.isBackup, settings: f.settings,
      steps: buildSteps(f.fields, (f.settings ?? {}) as { steps?: string[][] }).map(s => ({ title: s.title, sections: s.sections.map(x => x.code) })),
      fields: f.fields.map(x => ({ id: x.id, code: x.code, type: x.type, label: x.label, help: x.help, info: x.info, required: x.required, sortOrder: x.sortOrder, options: x.options, properties: x.properties, sensitivity: x.sensitivity, values: x._count.values })),
      actions: has(req, "forms.manage") ? f.actions : [],
      notices: f.notices,
    };
  });

  const Settings = z.object({
    title: z.string().trim().min(1).max(300), isOpen: z.boolean(),
    settings: z.object({
      submitButtonText: z.string().max(100).nullable(), thankYouHtml: z.string().max(50000).nullable(), requiredText: z.string().max(20),
      resultColumns: z.array(z.string().max(100)).max(10), useCaptcha: z.boolean(), steps: z.array(z.array(z.string().max(100)).min(1)).max(30),
    }).partial(),
  }).partial();
  r.put("/forms/:id", "forms.manage", async (req, reply) => {
    const b = Settings.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const f = await db.form.findUnique({ where: { id: Id.parse(req.params.id) } });
    if (!f) return reply.code(404).send({ error: "notFound" });
    const s = { ...(f.settings as Record<string, unknown>), ...(b.data.settings ?? {}) };
    if (b.data.settings?.thankYouHtml) s.thankYouHtml = sanitize(b.data.settings.thankYouHtml);
    await db.form.update({ where: { id: f.id }, data: { title: b.data.title, isOpen: b.data.isOpen, settings: s as Prisma.InputJsonValue } });
    await audit(req, "form.update", "Form", f.id, { fields: [...Object.keys(b.data), ...Object.keys(b.data.settings ?? {})] });
    return { ok: true };
  });

  const Field = z.object({
    code: z.string().regex(/^[\p{L}\w-]{1,60}$/u), type: z.enum(["DATE", "TEXT", "TEXTAREA", "DROPDOWN", "EMAIL", "FILE", "RADIO", "HEADING"]),
    label: z.string().trim().min(1).max(2000), help: z.string().max(2000).nullable(), info: z.string().max(20000).nullable(), required: z.boolean(),
    sortOrder: z.number().int(), options: z.array(z.string().trim().min(1).max(300)).max(200).nullable(),
    properties: z.record(z.string().max(2000)).nullable(), sensitivity: z.enum(["NONE", "PII", "ENCRYPTED"]),
  });
  const fieldData = (d: Partial<z.infer<typeof Field>>) => ({
    ...d, help: d.help === undefined ? undefined : clean(d.help), info: d.info === undefined ? undefined : d.info ? sanitize(d.info) || null : null,
    options: d.options === undefined ? undefined : (d.options ?? undefined) as Prisma.InputJsonValue | undefined,
    properties: d.properties === undefined ? undefined : (d.properties ?? {}) as Prisma.InputJsonValue,
  });
  r.post("/forms/:id/fields", "forms.manage", async (req, reply) => {
    const b = Field.partial({ help: true, info: true, required: true, sortOrder: true, options: true, properties: true, sensitivity: true }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const formId = Id.parse(req.params.id);
    if (await db.formField.findUnique({ where: { formId_code: { formId, code: b.data.code } } })) return reply.code(409).send({ error: "codeExists" });
    const max = (await db.formField.aggregate({ where: { formId }, _max: { sortOrder: true } }))._max.sortOrder ?? 0;
    const f = await db.formField.create({ data: { formId, sortOrder: max + 1, ...fieldData(b.data), label: b.data.label, code: b.data.code, type: b.data.type } as Prisma.FormFieldUncheckedCreateInput });
    await audit(req, "formfield.create", "FormField", f.id, { form: formId, code: f.code });
    return { id: f.id };
  });
  r.put("/forms/:id/fields/:fieldId", "forms.manage", async (req, reply) => {
    const b = Field.omit({ code: true }).partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const f = await db.formField.findFirst({ where: { id: Id.parse(req.params.fieldId), formId: Id.parse(req.params.id) }, include: { _count: { select: { values: true } } } });
    if (!f) return reply.code(404).send({ error: "notFound" });
    // Existing answers are stored either encrypted or in clear text; switching would need a data migration.
    if (b.data.sensitivity && (b.data.sensitivity === "ENCRYPTED") !== (f.sensitivity === "ENCRYPTED") && f._count.values) return reply.code(409).send({ error: "hasValues", values: f._count.values });
    if (b.data.type && b.data.type !== f.type && f._count.values) return reply.code(409).send({ error: "hasValues", values: f._count.values });
    await db.formField.update({ where: { id: f.id }, data: fieldData(b.data) as Prisma.FormFieldUpdateInput });
    await audit(req, "formfield.update", "FormField", f.id, { fields: Object.keys(b.data) });
    return { ok: true };
  });
  r.del("/forms/:id/fields/:fieldId", "forms.manage", async (req, reply) => {
    const f = await db.formField.findFirst({ where: { id: Id.parse(req.params.fieldId), formId: Id.parse(req.params.id) }, include: { _count: { select: { values: true } } } });
    if (!f) return reply.code(404).send({ error: "notFound" });
    // Answers are never deleted with a field: hide it from the form by moving it to a backup form instead.
    if (f._count.values) return reply.code(409).send({ error: "hasValues", values: f._count.values });
    await db.formField.delete({ where: { id: f.id } });
    await audit(req, "formfield.delete", "FormField", f.id, { code: f.code });
    return { ok: true };
  });
  r.put("/forms/:id/fields-order", "forms.manage", async (req, reply) => {
    const b = z.object({ ids: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const formId = Id.parse(req.params.id);
    await db.$transaction(b.data.ids.map((id, i) => db.formField.updateMany({ where: { id, formId }, data: { sortOrder: i + 1 } })));
    await audit(req, "formfield.reorder", "Form", formId);
    return { ok: true };
  });

  const Action = z.object({
    kind: z.enum(["NOTIFY", "CONFIRM"]), toAddresses: z.string().max(1000).nullable(), toFieldCode: z.string().max(100).nullable(),
    subject: z.string().trim().min(1).max(300), bodyHtml: z.string().max(100000), enabled: z.boolean(),
  });
  r.post("/forms/:id/actions", "forms.manage", async (req, reply) => {
    const b = Action.partial({ toAddresses: true, toFieldCode: true, bodyHtml: true, enabled: true }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const a = await db.formEmailAction.create({ data: { formId: Id.parse(req.params.id), ...b.data, bodyHtml: sanitize(b.data.bodyHtml ?? ""), enabled: b.data.enabled ?? false } });
    await audit(req, "formaction.create", "FormEmailAction", a.id);
    return { id: a.id };
  });
  r.put("/forms/:id/actions/:actionId", "forms.manage", async (req, reply) => {
    const b = Action.partial().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid", issues: b.error.issues });
    const a = await db.formEmailAction.findFirst({ where: { id: Id.parse(req.params.actionId), formId: Id.parse(req.params.id) } });
    if (!a) return reply.code(404).send({ error: "notFound" });
    await db.formEmailAction.update({ where: { id: a.id }, data: { ...b.data, bodyHtml: b.data.bodyHtml === undefined ? undefined : sanitize(b.data.bodyHtml) } });
    await audit(req, "formaction.update", "FormEmailAction", a.id, { fields: Object.keys(b.data) });
    return { ok: true };
  });
  r.del("/forms/:id/actions/:actionId", "forms.manage", async (req, reply) => {
    const del = await db.formEmailAction.deleteMany({ where: { id: Id.parse(req.params.actionId), formId: Id.parse(req.params.id) } });
    if (!del.count) return reply.code(404).send({ error: "notFound" });
    await audit(req, "formaction.delete", "FormEmailAction", req.params.actionId);
    return { ok: true };
  });
  r.post("/forms/:id/notices", "forms.manage", async (req, reply) => {
    const b = z.object({ lang: z.enum(["sq", "en", "sr"]), text: z.string().trim().min(20).max(10000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const formId = Id.parse(req.params.id);
    const version = ((await db.consentNotice.aggregate({ where: { formId, lang: b.data.lang }, _max: { version: true } }))._max.version ?? 0) + 1;
    const n = await db.consentNotice.create({ data: { formId, lang: b.data.lang, version, text: b.data.text.normalize("NFC") } });
    await audit(req, "consentnotice.create", "ConsentNotice", n.id, { form: formId, lang: b.data.lang, version });
    return { id: n.id, version };
  });

  // ─── Results (submissions) ───
  r.get("/forms/:id/submissions", "applications.view", async (req, reply) => {
    const form = await loadForm(Id.parse(req.params.id));
    if (!form) return reply.code(404).send({ error: "notFound" });
    const q = req.query as Record<string, string>;
    const pg = page(q, 200);
    const cols = (((form.settings ?? {}) as { resultColumns?: string[] }).resultColumns ?? []).map(c => form.fields.find(f => f.code === c)).filter((f): f is FormField => !!f && f.sensitivity !== "ENCRYPTED");
    const where: Prisma.SubmissionWhereInput = { formId: form.id, deletedAt: null };
    if (q.q) where.values = { some: { valueText: { contains: q.q, mode: "insensitive" }, field: { sensitivity: { not: "ENCRYPTED" } } } };
    if (q.from) where.createdAt = { ...(where.createdAt as object), gte: new Date(q.from) };
    if (q.to) where.createdAt = { ...(where.createdAt as object), lt: new Date(q.to) };
    const [total, rows] = await Promise.all([
      db.submission.count({ where }),
      db.submission.findMany({ where, orderBy: { createdAt: q.sort === "oldest" ? "asc" : "desc" }, take: pg.take, skip: pg.skip, include: { values: { where: { fieldId: { in: cols.map(c => c.id) } } } } }),
    ]);
    await audit(req, "submission.list", "Form", form.id, { page: pg.page, q: q.q ? true : undefined });
    return {
      total, page: pg.page, pageSize: pg.pageSize, columns: cols.map(c => ({ code: c.code, label: label(c) })),
      items: rows.map(s => ({ id: s.id, legacyItemId: s.legacyItemId, createdAt: s.createdAt, updatedAt: s.updatedAt, consentSource: s.consentSource, values: Object.fromEntries(cols.map(c => [c.code, display(c, s.values.find(v => v.fieldId === c.id), s.id)])) })),
    };
  });

  r.get("/submissions/:id", "applications.view", async (req, reply) => {
    const s = await loadSub(Id.parse(req.params.id));
    if (!s) return reply.code(404).send({ error: "notFound" });
    const purpose = (req.query as Record<string, string>).purpose === "print" ? "print" : "view";
    await audit(req, `submission.${purpose}`, "Submission", s.id);
    const steps = buildSteps(s.form.fields, (s.form.settings ?? {}) as { steps?: string[][] });
    const byId = new Map(s.form.fields.map(f => [f.id, f]));
    return {
      id: s.id, legacyItemId: s.legacyItemId, form: { id: s.form.id, key: s.form.key, title: s.form.title, lang: s.form.lang },
      createdAt: s.createdAt, updatedAt: s.updatedAt,
      consent: { source: s.consentSource, at: s.consentAt, notice: s.consentNotice ? { version: s.consentNotice.version, lang: s.consentNotice.lang, text: s.consentNotice.text } : null },
      steps: steps.map(st => ({ title: st.title, sections: st.sections.map(sec => ({ title: sec.title, fields: sec.fields.map(fd => { const f = byId.get(fd.id)!; return { id: f.id, code: f.code, type: f.type, label: label(f), sensitivity: f.sensitivity, options: f.options, value: display(f, s.values.find(v => v.fieldId === f.id), s.id) }; }) })) })),
    };
  });

  r.post("/submissions/:id/reveal", "applications.reveal", async (req, reply) => {
    const b = z.object({ reason: Reason, fields: z.array(z.string().max(100)).max(50).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "reason" });
    const s = await loadSub(Id.parse(req.params.id));
    if (!s) return reply.code(404).send({ error: "notFound" });
    const out: Record<string, string> = {};
    for (const f of s.form.fields.filter(x => x.sensitivity === "ENCRYPTED" && (!b.data.fields || b.data.fields.includes(x.code)))) {
      const v = s.values.find(x => x.fieldId === f.id);
      if (v?.valueEnc) out[f.code] = decrypt(s.id, f, v);
    }
    await audit(req, "submission.reveal", "Submission", s.id, { fields: Object.keys(out) }, b.data.reason);
    reply.header("Cache-Control", "no-store");
    return { values: out };
  });

  r.put("/submissions/:id", "applications.edit", async (req, reply) => {
    const b = z.object({ values: z.record(z.string().max(20000).nullable()) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid" });
    const s = await loadSub(Id.parse(req.params.id));
    if (!s) return reply.code(404).send({ error: "notFound" });
    const fields = s.form.fields.filter(f => f.code in b.data.values && f.type !== "FILE" && f.type !== "HEADING");
    // Same checks as the public form, for the changed fields only (an editor may clear a value).
    const input: Incoming = { values: new Map(fields.map(f => [f.code, b.data.values[f.code] ?? ""])), files: new Map() };
    const v = validate({ ...s.form, fields: fields.map(f => ({ ...f, required: false })) }, input);
    if (!v.ok) return reply.code(422).send({ error: "invalid", errors: v.errors });
    await db.$transaction(async tx => {
      for (const f of fields) {
        const val = v.checked.text.get(f.id);
        const where = { submissionId_fieldId: { submissionId: s.id, fieldId: f.id } };
        if (val == null) { await tx.submissionValue.deleteMany({ where: { submissionId: s.id, fieldId: f.id } }); continue; }
        const data: Prisma.SubmissionValueUncheckedCreateInput = { submissionId: s.id, fieldId: f.id, valueText: null, valueDate: null, valueEnc: null, encKid: null };
        if (f.sensitivity === "ENCRYPTED") { const e = encryptField(ring, val, valueAad(s.id, f.id)); data.valueEnc = new Uint8Array(e.enc); data.encKid = e.kid; }
        else if (f.type === "DATE") data.valueDate = new Date(`${val}T00:00:00Z`);
        else data.valueText = val;
        await tx.submissionValue.upsert({ where, update: data, create: data });
      }
      await tx.submission.update({ where: { id: s.id }, data: { updatedAt: new Date(), updatedById: req.admin!.user.id } });
    });
    await audit(req, "submission.edit", "Submission", s.id, { fields: fields.map(f => f.code) });
    return { ok: true };
  });

  r.del("/submissions/:id", "applications.delete", async (req, reply) => {
    const s = await db.submission.findFirst({ where: { id: Id.parse(req.params.id), deletedAt: null } });
    if (!s) return reply.code(404).send({ error: "notFound" });
    await db.submission.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
    await audit(req, "submission.delete", "Submission", s.id);
    return { ok: true };
  });

  // DigForm "Delete All": Administrators only, and the form key must be typed to confirm.
  r.post("/forms/:id/submissions/delete-all", "applications.delete", async (req, reply) => {
    const form = await db.form.findUnique({ where: { id: Id.parse(req.params.id) } });
    if (!form) return reply.code(404).send({ error: "notFound" });
    const b = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!b.success || b.data.confirm !== form.key) return reply.code(400).send({ error: "confirm", expected: "form key" });
    const res = await db.submission.updateMany({ where: { formId: form.id, deletedAt: null }, data: { deletedAt: new Date() } });
    await audit(req, "submission.delete_all", "Form", form.id, { count: res.count });
    return { ok: true, deleted: res.count };
  });

  async function sendPrivate(req: FastifyRequest, reply: FastifyReply, subId: number, fieldId: number, variant: string | undefined) {
    const v = await db.submissionValue.findUnique({ where: { submissionId_fieldId: { submissionId: subId, fieldId } }, include: { submission: true, file: { include: { variants: true } } } });
    if (!v?.file || v.submission.deletedAt || v.file.bucket !== "PRIVATE") return reply.code(404).send({ error: "notFound" });
    const vv = variant ? v.file.variants.find(x => x.kind === variant) : null;
    await audit(req, "submission.file", "Submission", subId, { field: fieldId, variant: vv?.kind });
    const name = (v.valueText ?? v.file.originalName).replace(/["\r\n]/g, "_");
    reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Disposition", `${(req.query as Record<string, string>).download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.type(vv?.mime ?? v.file.mime);
    return reply.sendFile(vv?.storageKey ?? v.file.storageKey, storageDir);
  }
  r.get("/submissions/:id/files/:fieldId", "applications.view", (req, reply) =>
    sendPrivate(req, reply, Id.parse(req.params.id), Id.parse(req.params.fieldId), (req.query as Record<string, string>).variant));

  // DigForm "Export TAB" (and CSV for Excel). Encrypted fields only with applications.reveal and a reason.
  r.get("/forms/:id/export", "applications.export", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const form = await loadForm(Id.parse(req.params.id));
    if (!form) return reply.code(404).send({ error: "notFound" });
    const sensitive = q.sensitive === "1";
    if (sensitive && (!has(req, "applications.reveal") || !Reason.safeParse(q.reason).success)) return reply.code(403).send({ error: "reason" });
    const fields = form.fields.filter(f => f.type !== "HEADING");
    const subs = await db.submission.findMany({ where: { formId: form.id, deletedAt: null }, orderBy: { createdAt: "asc" }, include: { values: true } });
    const csv = q.format === "csv";
    const sep = csv ? "," : "\t";
    const cell = (s: string) => {
      let v = s.replace(/\r?\n/g, " ");
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // spreadsheet formula injection
      return csv ? `"${v.replace(/"/g, '""')}"` : v.replace(/\t/g, " ");
    };
    const lines = [["ID", "Data", ...fields.map(label)].map(cell).join(sep)];
    for (const s of subs) {
      const row = [String(s.legacyItemId ?? s.id), s.createdAt.toISOString().replace("T", " ").slice(0, 16)];
      for (const f of fields) {
        const v = s.values.find(x => x.fieldId === f.id);
        row.push(f.sensitivity === "ENCRYPTED" ? (sensitive && v?.valueEnc ? decrypt(s.id, f, v) : v?.valueEnc ? "••••" : "") : plainOf(f, v));
      }
      lines.push(row.map(cell).join(sep));
    }
    await audit(req, "submission.export", "Form", form.id, { count: subs.length, format: csv ? "csv" : "tsv", sensitive }, sensitive ? q.reason : null);
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Disposition", `attachment; filename="${form.key}-${stamp}.${csv ? "csv" : "txt"}"`);
    reply.type(csv ? "text/csv; charset=utf-8" : "text/tab-separated-values; charset=utf-8");
    return "﻿" + lines.join("\r\n") + "\r\n";
  });

  // DigForm "Statistics": answers per choice field, submissions over time.
  r.get("/forms/:id/statistics", "applications.view", async (req, reply) => {
    const form = await loadForm(Id.parse(req.params.id));
    if (!form) return reply.code(404).send({ error: "notFound" });
    const choice = form.fields.filter(f => (f.type === "DROPDOWN" || f.type === "RADIO") && f.sensitivity !== "ENCRYPTED");
    const [total, counts, months] = await Promise.all([
      db.submission.count({ where: { formId: form.id, deletedAt: null } }),
      db.submissionValue.groupBy({ by: ["fieldId", "valueText"], where: { fieldId: { in: choice.map(f => f.id) }, submission: { deletedAt: null } }, _count: true }),
      db.$queryRaw<{ month: string; n: bigint }[]>`SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month, count(*) AS n FROM "Submission" WHERE "formId" = ${form.id} AND "deletedAt" IS NULL GROUP BY 1 ORDER BY 1`,
    ]);
    return {
      total, byMonth: months.map(m => ({ month: m.month, count: Number(m.n) })),
      fields: choice.map(f => ({ code: f.code, label: label(f), counts: counts.filter(c => c.fieldId === f.id).map(c => ({ value: c.valueText ?? "", count: c._count })).sort((a, b) => b.count - a.count) })),
    };
  });

}
