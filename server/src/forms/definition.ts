// Public view of a DigForm form: fields grouped into wizard steps by their HEADING fields.
import type { Form, FormField, PrismaClient } from "@prisma/client";

export interface FieldDto {
  id: number; code: string; type: FormField["type"]; label: string; required: boolean;
  help: string | null; info: string | null; options: string[] | null;
  accept: string | null; maxLength: number | null; encrypted: boolean;
}
export interface SectionDto { code: string | null; title: string | null; info: string | null; fields: FieldDto[] }
export interface StepDto { title: string; sections: SectionDto[] }
export interface FormDto {
  key: string; lang: string; title: string; open: boolean;
  submitText: string | null; requiredText: string; thankYouHtml: string | null;
  steps: StepDto[]; consent: { id: number; version: number; text: string } | null;
}

interface FormSettings { submitButtonText?: string | null; requiredText?: string; thankYouHtml?: string | null; steps?: string[][] }

const prop = (f: FormField, k: string) => ((f.properties ?? {}) as Record<string, string>)[k] ?? null;
// DigForm labels carry the required marker in the text ("Emri *"); the wizard shows its own.
const cleanLabel = (s: string) => s.replace(/\s*\*\s*$/, "").replace(/​/g, "").trim();

export function fieldDto(f: FormField): FieldDto {
  const max = Number(prop(f, "FP_MaxLength"));
  return {
    id: f.id, code: f.code, type: f.type, label: cleanLabel(f.label), required: f.required,
    help: f.help, info: f.info, options: Array.isArray(f.options) ? (f.options as string[]) : null,
    accept: f.type === "FILE" ? prop(f, "FP_FileExtension") : null,
    maxLength: max > 0 ? max : null, encrypted: f.sensitivity === "ENCRYPTED",
  };
}

/**
 * Sections start at each HEADING. Steps come from settings.steps (lists of heading codes, editable in the
 * form builder); without it every heading is its own step. The first section of a step names the step.
 */
export function buildSteps(fields: FormField[], settings: FormSettings): StepDto[] {
  const sections: SectionDto[] = [];
  for (const f of [...fields].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (f.type === "HEADING") sections.push({ code: f.code, title: cleanLabel(f.label), info: f.info, fields: [] });
    else {
      if (!sections.length) sections.push({ code: null, title: null, info: null, fields: [] });
      sections[sections.length - 1].fields.push(fieldDto(f));
    }
  }
  const groups = settings.steps?.length ? settings.steps : sections.map(s => [s.code ?? ""]);
  const used = new Set<SectionDto>();
  const steps: StepDto[] = [];
  for (const codes of groups) {
    const secs = codes.map(c => sections.find(s => (s.code ?? "") === c)).filter((s): s is SectionDto => !!s && !used.has(s));
    if (!secs.length) continue;
    secs.forEach(s => used.add(s));
    steps.push({ title: secs[0].title ?? "", sections: secs });
  }
  // Sections a stored step list does not mention (e.g. a heading added later) get their own step at the end.
  for (const s of sections) if (!used.has(s)) steps.push({ title: s.title ?? "", sections: [s] });
  return steps;
}

export type FormWithFields = Form & { fields: FormField[] };

export async function loadForm(db: PrismaClient, key: string): Promise<FormWithFields | null> {
  return db.form.findFirst({ where: { key, isBackup: false }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
}

export async function currentNotice(db: PrismaClient, form: Form) {
  return db.consentNotice.findFirst({ where: { formId: form.id, lang: form.lang }, orderBy: { version: "desc" } });
}

export async function formDto(db: PrismaClient, form: FormWithFields): Promise<FormDto> {
  const s = (form.settings ?? {}) as FormSettings;
  const notice = await currentNotice(db, form);
  return {
    key: form.key, lang: form.lang, title: form.title, open: form.isOpen,
    submitText: s.submitButtonText ?? null, requiredText: s.requiredText ?? "*", thankYouHtml: s.thankYouHtml ?? null,
    steps: buildSteps(form.fields, s),
    consent: notice ? { id: notice.id, version: notice.version, text: notice.text } : null,
  };
}

/** Which form each language of the apply page shows (as on the DNN site: Albanian, and Serbian under /en). */
export const APPLY_FORM: Record<string, string> = { sq: "sop-application-sq", en: "sop-application-sr" };
