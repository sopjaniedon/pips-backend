// Migration CLI.
//   pnpm migrate baseline                 legacy source counts
//   pnpm migrate run [--only 08,09]       ordered, re-runnable import (+ report in data/reports/<run>/)
//   pnpm migrate digest                   content digest of imported tables (equal across runs = idempotent)
//   pnpm migrate describe <Table…>        legacy column listing
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { select, closeLegacy } from "./legacy/mssql.js";
import { db } from "./db.js";
import { STEPS } from "./steps/index.js";
import { digest } from "./steps/17-19-contact-finalize.js";

export const BASELINE_QUERIES: Record<string, string> = {
  articles: "SELECT COUNT(*) n FROM EasyDNNNews",
  articlesActive: "SELECT COUNT(*) n FROM EasyDNNNews WHERE Active = 1",
  translationsEn: "SELECT COUNT(*) n FROM EasyDNNNewsContentLocalization WHERE LocaleCode = 'en-GB'",
  categories: "SELECT COUNT(*) n FROM EasyDNNNewsCategoryList",
  articleCategories: "SELECT COUNT(*) n FROM EasyDNNNewsCategories",
  programYearValues: "SELECT COUNT(*) n FROM EasyDNNfieldsMultiSelected",
  documents: "SELECT COUNT(*) n FROM EasyDNNNewsDocuments",
  galleryPictures: "SELECT COUNT(*) n FROM EasyGalleryPictures",
  articleRevisions: "SELECT COUNT(*) n FROM EasyDNNNewsArchive",
  htmlVersions: "SELECT COUNT(*) n FROM HtmlText",
  htmlModules: "SELECT COUNT(DISTINCT ModuleID) n FROM HtmlText",
  formFields: "SELECT COUNT(*) n FROM DigFormField",
  submissions: "SELECT COUNT(*) n FROM DigFormItem",
  submissionValues: "SELECT COUNT(*) n FROM DigFormItemData",
  contactMessages: "SELECT COUNT(*) n FROM Feedback",
  users: "SELECT COUNT(*) n FROM Users",
  urlProviderRows: "SELECT COUNT(*) n FROM EasyDNNnewsUrlNewProviderData",
  tabUrls: "SELECT COUNT(*) n FROM TabUrls",
};

async function baseline() {
  const out: Record<string, number> = {};
  for (const [k, q] of Object.entries(BASELINE_QUERIES)) out[k] = (await select<{ n: number }>(q))[0].n;
  // Prove the connection really is read-only (the DB is READ_ONLY and the login is db_datareader).
  const ro = await select<{ ro: number }>("SELECT CAST(DATABASEPROPERTYEX('PipsLegacy','Updateability') AS nvarchar(20)) AS ro");
  console.log(JSON.stringify({ updateability: ro[0].ro, counts: out }, null, 2));
}

async function describe(tables: string[]) {
  for (const t of tables) {
    const cols = await select<{ c: string; t: string; l: number | null; n: string }>(
      `SELECT COLUMN_NAME c, DATA_TYPE t, CHARACTER_MAXIMUM_LENGTH l, IS_NULLABLE n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${t.replace(/[^A-Za-z0-9_]/g, "")}' ORDER BY ORDINAL_POSITION`,
    );
    console.log(`${t}: ${cols.map(c => `${c.c}:${c.t}${c.l ? `(${c.l})` : ""}${c.n === "YES" ? "?" : ""}`).join(", ")}`);
  }
}

async function run(args: string[]) {
  const onlyArg = args.find(a => a.startsWith("--only"));
  const only = onlyArg ? (onlyArg.split("=")[1] ?? args[args.indexOf(onlyArg) + 1] ?? "").split(",").filter(Boolean) : null;
  const steps = STEPS.filter(s => !only || only.includes(s.id));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const lines = [`# Migration run ${runId}`, "", "Counts only — this report never contains personal data.", "", "| Step | Result | Counts | Seconds |", "|---|---|---|---|"];
  let failed = false;
  for (const step of steps) {
    const rec = await db.migrationRun.create({ data: { step: `${step.id} ${step.name}`, status: "running" } });
    const t0 = Date.now();
    try {
      const counts = await step.run();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      await db.migrationRun.update({ where: { id: rec.id }, data: { status: "ok", counts, finishedAt: new Date() } });
      console.log(`✔ ${step.id} ${step.name} (${secs}s)\n   ${JSON.stringify(counts)}`);
      lines.push(`| ${step.id} ${step.name} | ok | ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")} | ${secs} |`);
    } catch (e) {
      failed = true;
      const msg = e instanceof Error ? e.message : String(e);
      await db.migrationRun.update({ where: { id: rec.id }, data: { status: "failed", message: msg.slice(0, 2000), finishedAt: new Date() } });
      console.error(`✘ ${step.id} ${step.name}\n   ${msg}`);
      lines.push(`| ${step.id} ${step.name} | **FAILED** | ${msg.replace(/\n/g, " ").slice(0, 300)} | |`);
      break;
    }
  }
  const dir = resolve(process.cwd(), "..", "data", "reports", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), lines.join("\n") + "\n");
  console.log(`report: ${dir}/report.md`);
  if (failed) process.exitCode = 1;
}

const cmd = process.argv[2];
try {
  if (cmd === "baseline") await baseline();
  else if (cmd === "describe") await describe(process.argv.slice(3));
  else if (cmd === "run") await run(process.argv.slice(3));
  else if (cmd === "digest") console.log(JSON.stringify(await digest(), null, 2));
  else {
    console.error("usage: migrate baseline | run [--only 08,09] | digest | describe <Table…>");
    process.exitCode = 1;
  }
} finally {
  await closeLegacy();
  await db.$disconnect();
}
