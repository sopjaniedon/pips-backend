import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { clean, slugify } from "../lib/text.js";
import { CUSTOM_FIELD } from "../config/site-map.js";
import type { Step } from "./types.js";

export const categoriesStep: Step = {
  id: "03",
  name: "categories (hierarchy + English labels); empty 'Uncategorized' placeholders kept inactive",
  async run() {
    const cats = await select<{ CategoryID: number; CategoryName: string | null; Position: number | null; ParentCategory: number | null; Color: string | null }>(
      "SELECT CategoryID, CategoryName, Position, ParentCategory, Color FROM EasyDNNNewsCategoryList ORDER BY CategoryID",
    );
    const en = await select<{ CategoryID: number; Title: string }>(
      "SELECT CategoryID, Title FROM EasyDNNNewsCategoryLocalization WHERE LocaleCode = 'en-GB'",
    );
    let active = 0;
    for (const c of cats) {
      const name = clean(c.CategoryName) ?? `Category ${c.CategoryID}`;
      const isActive = !/^uncategori[sz]ed/i.test(name);
      if (isActive) active++;
      const data = { position: c.Position ?? 0, isActive, color: clean(c.Color) };
      const cat = await db.category.upsert({ where: { legacyId: c.CategoryID }, update: data, create: { ...data, legacyId: c.CategoryID } });
      await db.categoryTranslation.upsert({
        where: { categoryId_lang: { categoryId: cat.id, lang: "sq" } },
        update: { name, slug: slugify(name) }, create: { categoryId: cat.id, lang: "sq", name, slug: slugify(name) },
      });
      const e = en.find(x => x.CategoryID === c.CategoryID);
      if (e && clean(e.Title)) {
        const n = clean(e.Title)!;
        await db.categoryTranslation.upsert({
          where: { categoryId_lang: { categoryId: cat.id, lang: "en" } },
          update: { name: n, slug: slugify(n) }, create: { categoryId: cat.id, lang: "en", name: n, slug: slugify(n) },
        });
      }
    }
    // Second pass: parents (all rows exist now).
    const ids = new Map((await db.category.findMany({ select: { id: true, legacyId: true } })).map(c => [c.legacyId, c.id]));
    for (const c of cats) {
      const parentId = c.ParentCategory && c.ParentCategory > 0 ? ids.get(c.ParentCategory) ?? null : null;
      await db.category.update({ where: { legacyId: c.CategoryID }, data: { parentId } });
    }
    return { categories: cats.length, active, enLabels: en.length };
  },
};

export const programsStep: Step = {
  id: "04",
  name: "programs (custom field 'Programet') with English labels",
  async run() {
    const els = await select<{ FieldElementID: number; Text: string; Position: number }>(
      `SELECT FieldElementID, Text, Position FROM EasyDNNfieldsMultiElements WHERE CustomFieldID = ${CUSTOM_FIELD.programs} ORDER BY Position`,
    );
    const en = await select<{ FieldElementID: number; Text: string }>(
      "SELECT FieldElementID, Text FROM EasyDNNfieldsMultiElementsLocalization WHERE LocaleCode = 'en-GB'",
    );
    for (const e of els) {
      const name = clean(e.Text)!;
      const p = await db.program.upsert({
        where: { legacyId: e.FieldElementID },
        update: { key: slugify(name), position: e.Position }, create: { legacyId: e.FieldElementID, key: slugify(name), position: e.Position },
      });
      await db.programTranslation.upsert({ where: { programId_lang: { programId: p.id, lang: "sq" } }, update: { name }, create: { programId: p.id, lang: "sq", name } });
      const t = en.find(x => x.FieldElementID === e.FieldElementID);
      if (t && clean(t.Text)) {
        await db.programTranslation.upsert({ where: { programId_lang: { programId: p.id, lang: "en" } }, update: { name: clean(t.Text)! }, create: { programId: p.id, lang: "en", name: clean(t.Text)! } });
      }
    }
    const years = await select<{ n: number }>(`SELECT COUNT(*) n FROM EasyDNNfieldsMultiElements WHERE CustomFieldID = ${CUSTOM_FIELD.year}`);
    return { programs: els.length, programEnLabels: en.filter(x => els.some(e => e.FieldElementID === x.FieldElementID)).length, yearOptions: years[0].n };
  },
};
