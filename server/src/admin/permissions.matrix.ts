// Permission matrix: every admin route × anonymous, Translator (English), Editor and Administrator, against the
// throwaway pips_test database with synthetic fixtures. Run with `pnpm --filter @pips/server test:matrix`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { testUrl } from "../cli/test-db.js";

process.env.DATABASE_URL = testUrl();
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "pips-matrix-"));

const { buildApp } = await import("../app.js");
const { loadConfig } = await import("../config.js");
const { ROUTES } = await import("./registry.js");
const { ROLE_PERMISSIONS } = await import("../auth/permissions.js");
const { hashPassword, issueResetToken } = await import("../auth/session.js");
const { encryptField, keyringFromEnv, valueAad } = await import("../lib/crypto.js");

let app: FastifyInstance;
const ids: Record<string, number> = {};
const pw = () => randomBytes(18).toString("base64url");
const creds: Record<string, { login: string; password: string }> = {};
const sessions: Record<string, { cookie: string; csrf: string }> = {};
const PASSPORT = "TESTPP-998877";

async function login(role: string) {
  const r = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: creds[role] });
  expect(r.statusCode, `login ${role}`).toBe(200);
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  sessions[role] = { cookie, csrf: r.json().csrf };
}
const call = (role: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const s = role ? sessions[role] : null;
  return app.inject({
    method: method as "GET", url, payload: method === "GET" ? undefined : (payload ?? {}) as object,
    headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), ...headers },
  });
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  await app.ready();
  const db = app.db;
  const roles = Object.fromEntries((await db.role.findMany()).map(r => [r.key, r.id]));
  for (const [role, key] of [["admin", "administrator"], ["editor", "editor"], ["translator", "translator_en"]] as const) {
    creds[role] = { login: `${role}@matrix.test`, password: pw() };
    const u = await db.user.create({ data: { email: `${role}@matrix.test`, username: role, displayName: `Matrix ${role}`, status: "ACTIVE", passwordHash: await hashPassword(creds[role].password) } });
    await db.userRole.create({ data: { userId: u.id, roleId: roles[key] } });
    ids[role] = u.id;
  }
  // Content fixtures
  const cat = await db.category.create({ data: { translations: { create: [{ lang: "sq", name: "Aktivitete", slug: "aktivitete" }] } } });
  const spare = await db.category.create({ data: { translations: { create: [{ lang: "sq", name: "Bosh", slug: "bosh" }] } } });
  const prog = await db.program.create({ data: { key: "test-program", translations: { create: [{ lang: "sq", name: "Program" }] } } });
  const art = await db.article.create({ data: { status: "PUBLISHED", publishAt: new Date(), translations: { create: [{ lang: "sq", title: "Artikull testues", slug: "artikull-testues", bodyHtml: "<p>Tekst</p>" }, { lang: "en", title: "Test article", slug: "test-article" }] }, categories: { create: [{ categoryId: cat.id }] } } });
  const rev = await db.articleRevision.create({ data: { articleId: art.id, source: "APP", snapshot: { kind: "app", base: { status: "PUBLISHED", publishAt: new Date().toISOString(), expireAt: null }, categories: [cat.id], programs: [], translations: { sq: { title: "Artikull testues" } } } } });
  const doc = await db.document.create({ data: { title: "Dokument", legacyPath: "", fileName: "d.pdf", extension: "pdf", articles: { create: { articleId: art.id } } } });
  const gal = await db.galleryItem.create({ data: { articleId: art.id, mediaType: "VIDEO", embedUrl: "https://www.youtube.com/watch?v=x" } });
  const blockSq = await db.htmlBlock.create({ data: { key: "test", lang: "sq", html: "<p>sq</p>", revisions: { create: { version: 1, html: "<p>sq</p>" } } }, include: { revisions: true } });
  const blockEn = await db.htmlBlock.create({ data: { key: "test", lang: "en", html: "<p>en</p>" } });
  // Applications fixtures (encrypted passport number, private file)
  const form = await db.form.create({ data: { key: "matrix-form", lang: "sq", title: "Formular", settings: { resultColumns: ["Emri", "Persona_nr"] } } });
  const fName = await db.formField.create({ data: { formId: form.id, code: "Emri", type: "TEXT", label: "Emri *", required: true, sortOrder: 1, sensitivity: "PII" } });
  const fPass = await db.formField.create({ data: { formId: form.id, code: "Persona_nr", type: "TEXT", label: "Numri i pasaportës", sortOrder: 2, sensitivity: "ENCRYPTED" } });
  const fCv = await db.formField.create({ data: { formId: form.id, code: "CV", type: "FILE", label: "CV", sortOrder: 3, sensitivity: "PII" } });
  const fSpare = await db.formField.create({ data: { formId: form.id, code: "Unused", type: "TEXT", label: "Unused", sortOrder: 4 } });
  const action = await db.formEmailAction.create({ data: { formId: form.id, kind: "NOTIFY", toAddresses: "info@matrix.test", subject: "S" } });
  const storage = process.env.STORAGE_DIR!;
  mkdirSync(join(storage, "private/aa"), { recursive: true });
  writeFileSync(join(storage, "private/aa/aa.pdf"), "%PDF-1.4 matrix");
  const file = await db.file.create({ data: { bucket: "PRIVATE", sha256: "aa".repeat(32), size: 15n, mime: "application/pdf", ext: "pdf", originalName: "cv.pdf", storageKey: "private/aa/aa.pdf" } });
  const sub = await db.submission.create({ data: { formId: form.id, lang: "sq", consentSource: "FORM", consentAt: new Date() } });
  const e = encryptField(keyringFromEnv(), PASSPORT, valueAad(sub.id, fPass.id));
  await db.submissionValue.createMany({ data: [
    { submissionId: sub.id, fieldId: fName.id, valueText: "Testi" },
    { submissionId: sub.id, fieldId: fPass.id, valueEnc: new Uint8Array(e.enc), encKid: e.kid },
    { submissionId: sub.id, fieldId: fCv.id, fileId: file.id, valueText: "cv.pdf" },
  ] });
  const msg = await db.contactMessage.create({ data: { lang: "sq", email: "c@matrix.test", message: "Përshëndetje" } });
  const redirect = await db.redirect.create({ data: { fromPath: "/old-matrix", toPath: "/", source: "MANUAL" } });
  const pageMeta = await db.pageMeta.create({ data: { routeKey: "home", lang: "sq", title: "Ballina" } });
  Object.assign(ids, { art: art.id, rev: rev.id, doc: doc.id, gal: gal.id, cat: spare.id, prog: prog.id, blockSq: blockSq.id, blockSqRev: blockSq.revisions[0].id, blockEn: blockEn.id, form: form.id, field: fSpare.id, fCv: fCv.id, action: action.id, sub: sub.id, msg: msg.id, redirect: redirect.id, page: pageMeta.id, file: file.id });
  for (const r of ["admin", "editor", "translator"]) await login(r);
});

afterAll(async () => { await app?.close(); });

/** Fills route parameters with fixture ids. */
function url(u: string, variant: { lang?: string; block?: "sq" | "en" } = {}) {
  return u
    .replace("/articles/:id/revisions/:rev", `/articles/${ids.art}/revisions/${ids.rev}`)
    .replace("/html-blocks/:id/revisions/:rev", `/html-blocks/${ids.blockSq}/revisions/${ids.blockSqRev}`)
    .replace("/articles/:id/documents/:docId", `/articles/${ids.art}/documents/${ids.doc}`)
    .replace("/articles/:id/translations/:lang", `/articles/${ids.art}/translations/${variant.lang ?? "en"}`)
    .replace("/articles/:id", `/articles/${ids.art}`).replace("/gallery/:id", `/gallery/${ids.gal}`)
    .replace("/categories/:id", `/categories/${ids.cat}`).replace("/programs/:id", `/programs/${ids.prog}`)
    .replace("/html-blocks/:id", `/html-blocks/${variant.block === "en" ? ids.blockEn : ids.blockSq}`)
    .replace("/forms/:id/fields/:fieldId", `/forms/${ids.form}/fields/${ids.field}`).replace("/forms/:id/actions/:actionId", `/forms/${ids.form}/actions/${ids.action}`)
    .replace("/forms/:id", `/forms/${ids.form}`)
    .replace("/submissions/:id/files/:fieldId", `/submissions/${ids.sub}/files/${ids.fCv}`).replace("/submissions/:id", `/submissions/${ids.sub}`)
    .replace("/contact/:id", `/contact/${ids.msg}`).replace("/users/:id", `/users/${ids.translator}`)
    .replace("/settings/:key", "/settings/site.name").replace("/pages/:id", `/pages/${ids.page}`)
    .replace("/redirects/:id", `/redirects/${ids.redirect}`).replace("/media/:id", `/media/${ids.file}`).replace("/flags/:key", "/flags/careers");
}

const ROLE_KEY: Record<string, string> = { admin: "administrator", editor: "editor", translator: "translator_en" };
const SKIP = new Set(["POST /api/admin/auth/logout"]); // tested separately (it ends the session)

describe("applicant data protection", () => {
  it("requires the CSRF header on writes", async () => {
    const res = await app.inject({ method: "PUT", url: `/api/admin/flags/careers`, payload: { enabled: false }, headers: { cookie: sessions.admin.cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf");
  });

  it("masks passport fields and reveals them only with a reason, audited", async () => {
    const view = await call("editor", "GET", `/api/admin/submissions/${ids.sub}`);
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain(PASSPORT);
    expect((await call("editor", "POST", `/api/admin/submissions/${ids.sub}/reveal`, {})).statusCode).toBe(400);
    const rev = await call("editor", "POST", `/api/admin/submissions/${ids.sub}/reveal`, { reason: "Visa paperwork for Strasbourg" });
    expect(rev.json().values.Persona_nr).toBe(PASSPORT);
    const rows = await app.db.auditLog.findMany({ where: { entityType: "Submission", entityId: String(ids.sub), action: "submission.reveal" } });
    expect(rows.at(-1)?.reason).toBe("Visa paperwork for Strasbourg");
  });

  it("exports passport fields only with a reason", async () => {
    const plain = await call("editor", "GET", `/api/admin/forms/${ids.form}/export?format=csv`);
    expect(plain.statusCode).toBe(200);
    expect(plain.body).not.toContain(PASSPORT);
    expect((await call("editor", "GET", `/api/admin/forms/${ids.form}/export?sensitive=1`)).statusCode).toBe(403);
    const full = await call("editor", "GET", `/api/admin/forms/${ids.form}/export?sensitive=1&reason=${encodeURIComponent("Travel list for Strasbourg")}`);
    expect(full.body).toContain(PASSPORT);
  });

  it("serves applicant files to staff only, never publicly", async () => {
    const f = await call("editor", "GET", `/api/admin/submissions/${ids.sub}/files/${ids.fCv}`);
    expect(f.statusCode).toBe(200);
    expect(f.body).toContain("%PDF");
    expect((await call(null, "GET", `/files/${ids.file}/cv.pdf`)).statusCode).toBe(404);
  });

  it("keeps the audit log append-only", async () => {
    await expect(app.db.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'x'`)).rejects.toThrow();
    await expect(app.db.$executeRawUnsafe(`DELETE FROM "AuditLog"`)).rejects.toThrow();
  });
});

describe("permission matrix", () => {
  it("covers every admin route", () => expect(ROUTES.length).toBeGreaterThan(60));

  it("rejects anonymous calls on every protected route", async () => {
    const bad: string[] = [];
    for (const r of ROUTES.filter(r => r.need !== "public")) {
      const res = await call(null, r.method, url(r.url));
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  for (const role of ["translator", "editor", "admin"]) {
    it(`enforces permissions for ${role}`, async () => {
      const perms = new Set<string>(ROLE_PERMISSIONS[ROLE_KEY[role]]);
      const bad: string[] = [];
      const cases: { method: string; u: string; allowed: boolean }[] = [];
      for (const r of ROUTES.filter(x => x.need !== "public" && !SKIP.has(`${x.method} ${x.url}`))) {
        const allowed = r.need === "auth" || (Array.isArray(r.need) ? r.need : [r.need]).some(p => perms.has(p));
        // Language rules inside the handler: the translator edits English only.
        if (r.url.endsWith("/translations/:lang")) {
          cases.push({ method: r.method, u: url(r.url, { lang: "en" }), allowed });
          cases.push({ method: r.method, u: url(r.url, { lang: "sq" }), allowed: allowed && role !== "translator" });
        } else if (r.url.startsWith("/api/admin/html-blocks/:id") && r.method !== "GET") {
          cases.push({ method: r.method, u: url(r.url, { block: "sq" }), allowed: allowed && role !== "translator" });
        } else cases.push({ method: r.method, u: url(r.url), allowed });
      }
      for (const c of cases) {
        const res = await call(role, c.method, c.u, c.u.includes("/translations/") ? { title: "Matrix" } : c.u.includes("/html-blocks/") && c.method === "PUT" ? { html: "<p>x</p>" } : {});
        const denied = res.statusCode === 401 || res.statusCode === 403;
        if (c.allowed && (denied || res.statusCode >= 500)) bad.push(`${c.method} ${c.u} should be allowed → ${res.statusCode} ${res.body.slice(0, 120)}`);
        if (!c.allowed && res.statusCode !== 403) bad.push(`${c.method} ${c.u} should be 403 → ${res.statusCode}`);
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("accounts", () => {
  it("resets a password with a one-time token and ends old sessions", async () => {
    const token = await issueResetToken(app.db, ids.translator, 60_000);
    expect((await call(null, "POST", "/api/admin/auth/reset", { token, password: "short" })).statusCode).toBe(422);
    const next = pw();
    expect((await call(null, "POST", "/api/admin/auth/reset", { token, password: next })).statusCode).toBe(200);
    expect((await call(null, "POST", "/api/admin/auth/reset", { token, password: pw() })).statusCode).toBe(400);
    expect((await call("translator", "GET", "/api/admin/bootstrap")).statusCode).toBe(401);
    creds.translator.password = next;
    await login("translator");
  });

  it("refuses disabled accounts and signs out", async () => {
    expect((await call("admin", "PUT", `/api/admin/users/${ids.editor}`, { status: "DISABLED" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: creds.editor })).statusCode).toBe(401);
    expect((await call("admin", "PUT", `/api/admin/users/${ids.admin}`, { status: "DISABLED" })).statusCode).toBe(409);
    expect((await call("admin", "POST", "/api/admin/auth/logout")).statusCode).toBe(200);
    expect((await call("admin", "GET", "/api/admin/bootstrap")).statusCode).toBe(401);
  });

  it("shows the alumni page to signed-in editors only", async () => {
    expect((await call(null, "GET", "/alumni")).statusCode).toBe(401);
    await login("admin");
    expect((await call("translator", "GET", "/alumni")).statusCode).toBe(403);
    expect((await call("admin", "GET", "/alumni")).statusCode).toBe(200);
  });
});
