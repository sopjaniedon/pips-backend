import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { clean, decodeHtml, sanitize } from "../lib/text.js";
import { legacyKey } from "../lib/files.js";
import { decryptField, encryptField, keyringFromEnv, valueAad } from "../../../server/src/lib/crypto.js";
import type { Step } from "./types.js";
import type { FieldType, Lang, Prisma, Sensitivity } from "@prisma/client";

/** Legacy DigForm modules → forms. Serbian form 4349 sits on the English page tree in DNN. */
const FORMS: Record<number, { key: string; lang: Lang; title: string; isOpen: boolean; isBackup: boolean }> = {
  4345: { key: "sop-application-sq", lang: "sq", title: "Aplikimi për Shkollën Politike", isOpen: true, isBackup: false },
  4349: { key: "sop-application-sr", lang: "sr", title: "Prijava za Političku školu", isOpen: true, isBackup: false },
  4348: { key: "sop-application-backup", lang: "sq", title: "Aplikimi (kopje rezervë)", isOpen: false, isBackup: true },
  4344: { key: "sop-application-draft", lang: "sq", title: "Aplikimi (draft i vjetër)", isOpen: false, isBackup: true },
};

/** Encrypted at rest; masked in the admin and revealed only with a recorded reason. */
const ENCRYPTED_CODES = new Set(["Persona_nr", "Data_leshimit", "Data_skadimit", "Vendi_leshimit"]);
/** Personal data shown to authorised users; access is audited. */
const PII_CODES = new Set(["Foto_profilit", "Emri", "Mbiemri", "Birthdate", "Birthplace", "Kombësia", "Gjinia", "Adresa", "Qyteti", "Shteti", "Nr_mobil", "Email_adresa", "CV", "Leter_rekomandimi", "Diploma"]);

const FIELD_TYPE: Record<number, FieldType> = { 1: "DATE", 3: "TEXT", 6: "TEXTAREA", 7: "DROPDOWN", 15: "EMAIL", 25: "FILE", 29: "RADIO", 30: "HEADING" };

/** DigForm Properties: "~DK~<key>~DV~<value>" pairs. */
function parseProps(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split("~DK~").slice(1)) {
    const i = part.indexOf("~DV~");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 4);
  }
  return out;
}

/** Data notice shown above the submit button (spec requirement). Text to be confirmed by PIPS. */
const NOTICE: Partial<Record<Lang, string>> = {
  sq: "PIPS i mbledh këto të dhëna vetëm për përzgjedhjen e pjesëmarrësve në Shkollën Politike dhe për organizimin e vizitës studimore në Strasburg. Të dhënat e pasaportës ruhen të enkriptuara dhe i shohin vetëm personat e autorizuar të PIPS. Mund të kërkoni fshirjen e të dhënave tuaja në çdo kohë në info@pips-ks.org.",
  sr: "PIPS prikuplja ove podatke isključivo radi izbora učesnika Političke škole i organizacije studijske posete Strazburu. Podaci iz pasoša čuvaju se šifrovani i vidljivi su samo ovlašćenim osobama PIPS-a. U svakom trenutku možete zatražiti brisanje svojih podataka na info@pips-ks.org.",
};

// The prototype's 8-step wizard expressed over DigForm's own headings (identical in the sq and sr forms).
const WIZARD_STEPS = [
  ["Personal_Info", "Pasaporta", "Kontaktet"],
  ["Info_shkollimi", "St_post_uni", "Studimet_post_uni_ma", "Studimet_bachelor"],
  ["Punesimi_aktual"],
  ["Angazhimet_tjera"],
  ["Njohuri_gjuhe"],
  ["Letër_motivimi"],
  ["Dokumentet"],
];

export const formsStep: Step = {
  id: "15",
  name: "forms: fields, options, settings, result columns, email actions (imported DISABLED), consent notices",
  async run() {
    const fields = await select<{ FieldID: number; ModuleID: number; Code: string; FieldType: number; Properties: string | null; Label: string | null; Help: string | null; Info: string | null; IsRequired: boolean; SortOrder: number }>(
      `SELECT FieldID, ModuleID, Code, FieldType, Properties, Label, Help, Info, IsRequired, SortOrder FROM DigFormField WHERE ModuleID IN (${Object.keys(FORMS).join(",")}) ORDER BY ModuleID, SortOrder`,
    );
    const settings = await select<{ ModuleID: number; SettingName: string; SettingValue: string }>(
      `SELECT ModuleID, SettingName, SettingValue FROM ModuleSettings WHERE ModuleID IN (${Object.keys(FORMS).join(",")}) AND SettingName NOT IN ('ActivationKey')`,
    );
    const submits = await select<{ SubmitID: number; ModuleID: number; SubmitType: number; EmailSubject: string | null; EmailHeader: string | null; EmailBody: string | null; EmailFooter: string | null; EmailUsers: string | null; EmailFields: string | null }>(
      `SELECT SubmitID, ModuleID, SubmitType, EmailSubject, EmailHeader, EmailBody, EmailFooter, EmailUsers, EmailFields FROM DigFormSubmit WHERE ModuleID IN (${Object.keys(FORMS).join(",")})`,
    );
    const codeOf = new Map(fields.map(f => [f.FieldID, f.Code]));
    let nFields = 0, nActions = 0;

    for (const [moduleIdStr, def] of Object.entries(FORMS)) {
      const moduleId = Number(moduleIdStr);
      const s = (n: string) => settings.find(x => x.ModuleID === moduleId && x.SettingName === n)?.SettingValue;
      const formSettings = {
        submitButtonText: s("SubmitButtonText") ?? null,
        thankYouHtml: sanitize(decodeHtml(s("SubmitThankMessage"))),
        resultColumns: [1, 2, 3, 4, 5].map(i => codeOf.get(Number(s(`ResultCol${i}`)))).filter((c): c is string => !!c),
        useCaptcha: s("UseCaptcha") === "1",
        restrictSubmitAccess: s("RestrictSubmitAccess") === "1",
        printAfterSubmit: s("PrintAfterSubmit") === "1",
        viewResultsRole: s("ViewResultsRole") ?? null,
        requiredText: s("RequiredText") ?? "*",
        legacyViewCount: Number(s("ViewCount") ?? 0),
        // Wizard steps for the new site (lists of HEADING codes); editable later in the form builder.
        steps: WIZARD_STEPS,
      };
      const form = await db.form.upsert({
        where: { legacyModuleId: moduleId },
        update: { ...def, settings: formSettings },
        create: { ...def, settings: formSettings, legacyModuleId: moduleId },
      });

      for (const f of fields.filter(x => x.ModuleID === moduleId)) {
        const props = parseProps(f.Properties);
        const type = FIELD_TYPE[f.FieldType] ?? "TEXT";
        const options = props.FP_Items ? props.FP_Items.split(/\r?\n/).map(o => o.trim()).filter(o => o && !/^-\s*(zgjidh|izaberi)\s*-$/i.test(o)) : null;
        const { FP_Items: _items, FP_Content: content, VER: _v, ...rest } = props;
        const sensitivity: Sensitivity = ENCRYPTED_CODES.has(f.Code) ? "ENCRYPTED" : PII_CODES.has(f.Code) ? "PII" : "NONE";
        const data = {
          formId: form.id, code: f.Code, type, label: clean(decodeHtml(f.Label)) ?? f.Code,
          help: clean(decodeHtml(f.Help)), info: type === "HEADING" ? sanitize(decodeHtml(content)) || null : clean(decodeHtml(f.Info)),
          required: f.IsRequired, sortOrder: f.SortOrder, options: options ?? undefined, properties: rest as Prisma.InputJsonValue, sensitivity,
        };
        await db.formField.upsert({ where: { legacyFieldId: f.FieldID }, update: data, create: { ...data, legacyFieldId: f.FieldID } });
        nFields++;
      }

      for (const a of submits.filter(x => x.ModuleID === moduleId && x.SubmitType === 0)) {
        const confirmField = clean(a.EmailFields)?.split(",").map(id => codeOf.get(Number(id))).find(Boolean) ?? null;
        const data = {
          formId: form.id, kind: confirmField ? ("CONFIRM" as const) : ("NOTIFY" as const),
          toAddresses: confirmField ? null : clean(a.EmailUsers), toFieldCode: confirmField,
          subject: clean(a.EmailSubject) ?? def.title,
          bodyHtml: sanitize([a.EmailHeader, a.EmailBody, a.EmailFooter].map(x => decodeHtml(x)).join("\n")),
          enabled: false, // switched on only at go-live, after the sender moves to a pips-ks.org address
        };
        await db.formEmailAction.upsert({ where: { legacyId: a.SubmitID }, update: data, create: { ...data, legacyId: a.SubmitID } });
        nActions++;
      }

      const notice = NOTICE[def.lang];
      if (notice && !def.isBackup) {
        await db.consentNotice.upsert({
          where: { formId_lang_version: { formId: form.id, lang: def.lang, version: 1 } },
          update: { text: notice }, create: { formId: form.id, lang: def.lang, version: 1, text: notice },
        });
      }
    }
    return { forms: Object.keys(FORMS).length, formFields: nFields, emailActions: nActions, encryptedFields: await db.formField.count({ where: { sensitivity: "ENCRYPTED" } }) };
  },
};

export const submissionsStep: Step = {
  id: "16",
  name: "submissions: values (passport fields encrypted in-process), uploaded files linked; IPs not migrated",
  async run() {
    const ring = keyringFromEnv();
    const items = await select<{ ItemID: number; ModuleID: number; CreateDate: Date; AttachmentKey: string | null }>(
      `SELECT ItemID, ModuleID, CreateDate, AttachmentKey FROM DigFormItem WHERE ModuleID IN (${Object.keys(FORMS).join(",")}) ORDER BY ItemID`,
    );
    const data = await select<{ ItemID: number; FieldID: number; ValueText: string | null; ValueDate: Date | null; ValueNumber: number | null }>(
      "SELECT ItemID, FieldID, ValueText, ValueDate, ValueNumber FROM DigFormItemData",
    );
    const byItem = new Map<number, typeof data>();
    for (const d of data) byItem.set(d.ItemID, [...(byItem.get(d.ItemID) ?? []), d]);
    const forms = new Map((await db.form.findMany()).map(f => [f.legacyModuleId!, f]));
    const fieldsByLegacy = new Map((await db.formField.findMany()).map(f => [f.legacyFieldId!, f]));
    const fileByKey = new Map((await db.legacyPath.findMany({ where: { fileId: { not: null }, path: { startsWith: "/portals/0/digform/" } } })).map(p => [p.path, p.fileId!]));

    let nValues = 0, nEncrypted = 0, nFiles = 0, nMissingFile = 0;
    for (const it of items) {
      const form = forms.get(it.ModuleID)!;
      const sub = await db.submission.upsert({
        where: { legacyItemId: it.ItemID },
        update: { formId: form.id, lang: form.lang, attachmentKey: it.AttachmentKey, consentSource: "NONE_LEGACY", createdAt: it.CreateDate, updatedAt: it.CreateDate },
        create: { legacyItemId: it.ItemID, formId: form.id, lang: form.lang, attachmentKey: it.AttachmentKey, consentSource: "NONE_LEGACY", createdAt: it.CreateDate, updatedAt: it.CreateDate },
      });
      // Keep existing ciphertext when the plaintext is unchanged, so re-runs don't rewrite encrypted values.
      const existing = new Map((await db.submissionValue.findMany({ where: { submissionId: sub.id } })).map(v => [v.fieldId, v]));
      const rows: Prisma.SubmissionValueCreateManyInput[] = [];
      for (const d of byItem.get(it.ItemID) ?? []) {
        const field = fieldsByLegacy.get(d.FieldID);
        if (!field) continue;
        const text = d.ValueText?.normalize("NFC") ?? null;
        const row: Prisma.SubmissionValueCreateManyInput = { submissionId: sub.id, fieldId: field.id };
        if (field.type === "FILE") {
          if (text) {
            const fileId = fileByKey.get(legacyKey(`/Portals/0/DigForm/${text.replace(/^\/+/, "")}`));
            if (fileId) { row.fileId = fileId; nFiles++; } else nMissingFile++;
            row.valueText = text.split("/").pop()!.replace(/^\d+_/, "");
            row.valueNumber = d.ValueNumber ?? undefined;
          }
        } else if (field.sensitivity === "ENCRYPTED") {
          // DigForm keeps dates in ValueDate (ValueText is empty), so encrypt the ISO date for DATE fields.
          const plain = field.type === "DATE" ? (d.ValueDate ? d.ValueDate.toISOString().slice(0, 10) : null) : text;
          if (plain) {
            const aad = valueAad(sub.id, field.id);
            const old = existing.get(field.id);
            let reuse = false;
            if (old?.valueEnc && old.encKid) { try { reuse = decryptField(ring, old.valueEnc, old.encKid, aad) === plain; } catch { /* re-encrypt */ } }
            if (reuse) { row.valueEnc = old!.valueEnc!; row.encKid = old!.encKid!; }
            else { const e = encryptField(ring, plain, aad); row.valueEnc = new Uint8Array(e.enc); row.encKid = e.kid; }
            nEncrypted++;
          }
        } else {
          row.valueText = text;
          if (field.type === "DATE") row.valueDate = d.ValueDate ?? undefined;
        }
        rows.push(row);
      }
      await db.$transaction([
        db.submissionValue.deleteMany({ where: { submissionId: sub.id } }),
        db.submissionValue.createMany({ data: rows }),
      ]);
      nValues += rows.length;
    }
    return { submissions: items.length, submissionValues: nValues, encryptedValues: nEncrypted, fileValuesLinked: nFiles, fileValuesMissing: nMissingFile };
  },
};

export const formsVerifyStep: Step = {
  id: "21",
  name: "verify forms: counts, no plaintext in encrypted fields, decryption round-trip",
  async run() {
    const ring = keyringFromEnv();
    const one = async (q: string) => Number((await select<{ n: number }>(q))[0].n);
    const pg = async (q: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(q))[0].n);
    const checks: [string, number, number][] = [
      ["formFields", await one(`SELECT COUNT(*) n FROM DigFormField WHERE ModuleID IN (${Object.keys(FORMS).join(",")})`), await db.formField.count()],
      ["submissions", await one("SELECT COUNT(*) n FROM DigFormItem"), await db.submission.count({ where: { legacyItemId: { not: null } } })],
      ["submissionValues", await one("SELECT COUNT(*) n FROM DigFormItemData"), await db.submissionValue.count()],
      ["fileValues", await one("SELECT COUNT(*) n FROM DigFormItemData d JOIN DigFormField f ON f.FieldID = d.FieldID WHERE f.FieldType = 25 AND LEN(d.ValueText) > 0"), await db.submissionValue.count({ where: { fileId: { not: null } } })],
    ];
    const bad = checks.filter(([, a, b]) => a !== b).map(([k, a, b]) => `${k}: source ${a} ≠ target ${b}`);
    // Per field: every legacy value that holds something (text, date or file) must hold something here too.
    const src = await select<{ FieldID: number; n: number }>(
      `SELECT d.FieldID, COUNT(*) n FROM DigFormItemData d JOIN DigFormField f ON f.FieldID = d.FieldID
       WHERE f.ModuleID IN (${Object.keys(FORMS).join(",")}) AND (LEN(d.ValueText) > 0 OR d.ValueDate IS NOT NULL) GROUP BY d.FieldID`,
    );
    const dst = new Map((await db.$queryRawUnsafe<{ legacy: number; n: bigint }[]>(
      `SELECT f."legacyFieldId" legacy, count(*) n FROM "SubmissionValue" v JOIN "FormField" f ON f.id = v."fieldId"
       WHERE coalesce(v."valueText", '') <> '' OR v."valueDate" IS NOT NULL OR v."valueEnc" IS NOT NULL OR v."fileId" IS NOT NULL GROUP BY 1`,
    )).map(r => [r.legacy, Number(r.n)]));
    const fieldCode = new Map((await db.formField.findMany({ select: { legacyFieldId: true, code: true } })).map(f => [f.legacyFieldId!, f.code]));
    for (const s of src) {
      const got = dst.get(s.FieldID) ?? 0;
      // File values whose file is missing on disk keep their name, so they still count as filled.
      if (got !== s.n) bad.push(`field ${fieldCode.get(s.FieldID) ?? s.FieldID}: ${s.n} filled in source ≠ ${got} here`);
    }
    const plaintext = await pg(`SELECT count(*) n FROM "SubmissionValue" v JOIN "FormField" f ON f.id = v."fieldId" WHERE f.sensitivity = 'ENCRYPTED' AND (v."valueText" IS NOT NULL OR v."valueDate" IS NOT NULL)`);
    if (plaintext) bad.push(`${plaintext} encrypted-field values stored in plaintext`);
    const sample = await db.submissionValue.findMany({ where: { valueEnc: { not: null } }, take: 50, orderBy: { id: "asc" } });
    let roundTrips = 0;
    for (const v of sample) { decryptField(ring, v.valueEnc!, v.encKid!, valueAad(v.submissionId, v.fieldId)); roundTrips++; }
    if (bad.length) throw new Error("verification failed:\n  " + bad.join("\n  "));
    return Object.fromEntries([...checks.flatMap(([k, a, b]) => [[`${k}.source`, a], [`${k}.target`, b]]), ["plaintextInEncryptedFields", plaintext], ["decryptRoundTrips", roundTrips]]);
  },
};
