# PIPS: real backend with all legacy data and DNN feature parity

## Context
PIPS's current site (pips-ks.org) runs on DotNetNuke 9. We now have the full **production database backup** (`Pips-ks.org13.10.2026.bak`, restored read-only in a local SQL Server container) and the **full site copy** (`Portals/0`, 7.6 GB). The user wants our backend to:
- hold **all their data and files**;
- provide **exactly the functions the old site had**, nothing new.

Our clickable prototype (public site + admin, `~/Desktop/pips/prototype`, branch `backend`) becomes the real UI on top of a real API.

**User decisions:**
- **Backend:** a real one, in Node + TypeScript (Fastify) + PostgreSQL + Prisma. Local Docker first; deploying comes later.
- **Scope:** DNN parity plus security basics only:
  - passport/ID fields encrypted, with masked display and reveal-with-reason;
  - an audit log of who viewed or exported applicant data;
  - consent and a data notice on the application form.

  The prototype extras (stages, scoring, reviewers, decision emails, tags, careers, subscribers, …) are hidden behind feature flags that are off.
- **Content model:** keep DNN's. One article store with categories, programs and year, plus documents, galleries and translations. New pages are views over categories (no new content types).
- **Pages with no DNN backend** (careers, newsletter, alumni directory, generation lists): static content, forms disabled.
- **History:** import current content, view/download counters, and revision history for articles and HTML blocks. Skip the raw download log (it contains IPs).
- **Files:** migrate all originals the database references (≈4,074 files, ≈6.6 GiB). Regenerate thumbnails; skip caches and orphans, but report them.

## Legacy inventory (what we must carry over)

| Area | Source | Volume | Functions to keep |
|---|---|---|---|
| Articles | `EasyDNNNews` (sq base) + `ContentLocalization` (en) | 314 + 255 EN | List/detail, paging, latest / most read, featured → home slider, view counter, publish/expire dates, detail type Text / None / Link, SEO meta/OG, slugs |
| Categories | `EasyDNNNewsCategoryList` / `Categories` | 21 real (of 55) / 316 links | Activities 5, Publications 6, Per Ne → 7 / 8 Team / 9 Board / 10 Donors, SHP → 11 / 13 / 14 Alumni / 16, Programs 18–21, Partners 17, Donors 22 |
| Programs & year | `EasyDNNfields` 3 / 4 + `MultiSelected` | 5 programs, years 2008–2030, 556 values | Program pages; search filter by program and year |
| Documents | `EasyDNNNewsDocuments` + `DocumentItems` | 191 (1.15 GB) | Download with counter; served from old handler URLs |
| Gallery | `EasyGallery` / `EasyGalleryPictures` | 1,518 (3.8 GB), 2 YouTube | Per-article gallery; `ShowMedia=False` = copy of the cover |
| Sliders | Rotators 382 / 2147, 401 / 2207 | config only | Home = featured activities with an image; School of Politics = category 14 testimonials |
| HTML blocks | `HtmlText` | ~96 live modules, 397 versions | Editable static text per page and language (banners, stats, map, footer/social), with version history |
| Forms | `DigForm*` | 4345 sq (66 fields, 661 items), 4349 sr (65, 11), 4348 backup (76, 0), 4344 draft | Public form with uploads; 2 emails (notify info@, confirm applicant); results grid, view, edit, print, Export TAB, delete, Delete All, statistics; field builder |
| Applicant files | `Portals/0/DigForm/<AttachmentKey>/<FieldID>_<name>` | 2,053 (1.55 GB) | Private, viewable by authorised users only |
| Contact | `Feedback` | 640 (sq 553, en 87) | Form → email to info@ + admin-only list |
| Users & roles | `Users` / `Roles` | 8 users; Administrators, Editor (views/edits application results — confirmed `ViewResultsRole=Editor`), Translator (en-GB, edits EN) | Login, password reset, role-based edit rights; Alumni page Editor-only |
| URLs / SEO | `UrlNewProviderData` 7,665, `TabUrls` 32, document handler links, `/Portals/0/...` paths | | 301 redirects, sitemap, RSS, GA, OG |

## Architecture

**Repo:** `~/Desktop/pips`. Work on a new branch `backend-api` off `backend`; never push to `main`.

```
web/                 ← git mv prototype/ web/  (public HTML pages + admin SPA)
server/              Fastify + Prisma API, SSR shell, file serving
migration/           read-only legacy reader (mssql) + ordered import steps + report
infra/               docker-compose.yml, mssql/restore.sh, .env.example
e2e/                 Playwright (synthetic data only)
data/                gitignored: storage/{public,private}, reports, tmp
```

**Docker Compose** (every port bound to `127.0.0.1`):

| Service | Image / purpose | Notes |
|---|---|---|
| `postgres` | postgres:16 | with `unaccent`, `pg_trgm`, `citext` |
| `api` | Node 22 | The API |
| `mailpit` | captures every email locally | Real email can only be sent with `MAIL_MODE=live` in production |
| `legacy-mssql` | profile `legacy` | Restores the `.bak` from `LEGACY_BAK_DIR`, creates a `db_datareader` login, then sets the database `READ_ONLY` |
| `migrate` | profile `migrate` | Mounts `LEGACY_PORTALS_DIR` read-only |

**Secrets:** `.env` is never committed; only `.env.example` is. It holds:
- `PII_KEYS` (AES-256-GCM keys with a key id each), `SESSION_SECRET`;
- `DATABASE_URL`, the legacy paths, and the SMTP settings.

**Data protection:**
- Data, dumps, `.bak`, `.mdf` and reports are added to `.gitignore`.
- Nothing from the legacy webroot (`web.config`, `App_Data`) goes into the repo.

**Port the newer prototype copy** from `~/Downloads/test/pips/prototype` into `web/`, then:
- remove the `PIPS_LIVE`, `applyLive`, `toStored` and `fromStored` code and the `live-data.js` tag;
- leave `.githooks/pre-push` (Wiz) untouched.

## Database schema (Prisma; every imported row keeps `legacyId`)
- **Auth:**
  - `User`: argon2id hash, status `INVITED`/`ACTIVE`/`DISABLED`. **DNN password hashes are not migrated.** Users set a password through a reset email.
  - `Role` (`administrator`, `editor`, `translator_en`), `UserRole`, `RolePermission`, `Session`, `PasswordResetToken`.
- **Content:**
  - `Article`: status, publishAt, expireAt, featured, detailType, linkUrl, coverFileId, showGallery, publicationYear, analyticalType?, hideDefaultLocale, viewCount, author.
  - `ArticleTranslation`: lang `sq`/`en`, title, subtitle, summary, bodyHtml, bodyText, slug, meta, ogJson, documentTitles, plus a full-text `search` tsvector.
  - `Category` + translations; `Program` + translations; `ArticleCategory`; `ArticleProgram`.
  - `Document` (downloadCount) + `ArticleDocument`; `GalleryItem` (image / embed, visible, isCoverCopy).
  - `ArticleRevision`.
- **Files:**
  - `File`: bucket `PUBLIC`/`PRIVATE`, sha256, originalName (NFC), mime, size, dimensions, storageKey.
  - `FileVariant`: webp at 400 / 800 / 1600, JPEG made from HEIC.
  - `LegacyPath`: normalised old path → file.
- **Pages:** `HtmlBlock` (key, lang, html, legacyModuleId, mapped) + `HtmlBlockRevision`; `PageMeta` (route, lang, SEO, requiredPermission).
- **Forms:**
  - `Form` (key, lang, legacyModuleId, isOpen, isBackup, settings: submit text, thank-you HTML, result columns, captcha).
  - `FormField` (code, type, label, help, required, sort, options, sensitivity `NONE`/`PII`/`ENCRYPTED`).
  - `FormEmailAction` (NOTIFY / CONFIRM, enabled); `ConsentNotice` (lang, version, text).
  - `Submission` (formId, createdAt, consent, deletedAt) + `SubmissionValue` (EAV: text/date/number/fileId, or `valueEnc` + key id for encrypted fields).
- **Other:**
  - `ContactMessage` (+ spamFlag); `Redirect` (from → to, 301 / 410, source, hits).
  - `Setting`; `FeatureFlag`; `MigrationRun`.
  - `AuditLog`, append-only: a database trigger blocks UPDATE and DELETE.

## Migration pipeline (`migration/`)
**How it runs:**
- `pnpm migrate run [--only NN] [--dry-run]`.
- **Re-runnable:** every step upserts by legacy key, so running it twice changes nothing.
- **Read-only on the old data:** it uses a read-only login against the legacy database.
- **No email is ever sent:** the mailer isn't even imported.
- **Report without personal data:** `data/reports/<run>/report.md` covers counts, bytes, missing files, orphans and skipped caches.

**Steps:**

| # | Step | Key rules |
|---|---|---|
| 00 | Preflight | Check paths and keys; snapshot source counts as the baseline |
| 01 | Users / roles | 8 users imported as `INVITED`, without passwords |
| 02 | Settings | GA id, site name, time zone, logo, favicon, social links (from the footer block) |
| 03 | Categories | All 55; 21 active; hierarchy and translations; `config/category-map.ts` defines the page views |
| 04 | Programs / years | 5 programs; year → `publicationYear` |
| 05 | File index | Walk `Portals/0`; normalise to NFC + lowercase, strip `.resources`. Collect every DB reference, including `/Portals/0/…` links inside HTML |
| 06 | File copy | Streamed sha256, copied into the bucket, deduplicated per bucket, one `LegacyPath` per old path. Expect exactly 2 known missing gallery images |
| 07 | Variants | sharp: auto-rotate, strip EXIF, webp 400 / 800 / 1600. HEIC → JPEG via `heic-convert`; `.jfif` treated as JPEG. Private images get private, admin-only thumbnails |
| 08 | Articles + EN | HTML-decode (`he`), rewrite `/Portals` and old article links, sanitise with an allowlist (iframes only from YouTube / Vimeo / Google Maps), keep the raw HTML as a legacy revision, map status / dates / featured / detail type / SEO / views |
| 09 | Links | Article↔category (316) and article↔program/year (556) |
| 10 | Documents | 191, keeping position, download count and titles (titles feed search) |
| 11 | Gallery | 1,518 items (cover copies → `visible=false`), including the 2 YouTube embeds |
| 12 | Revisions | 931 from `EasyDNNNewsArchive` |
| 13 | HTML blocks | `config/html-block-map.ts` maps the ~96 live modules to page slots per language. All 397 versions become revisions. Unmapped blocks are kept as `legacy:<moduleId>` |
| 14 | Pages + redirects | TabUrls (32), UrlProvider (7,665), document-handler links, `/Portals/0/…` → `/files/…`, and **`/Portals/0/DigForm/*` → 410** |
| 15 | Forms | 4345 / 4349 / 4348 / 4344: parse the `~DK~…~DV~` properties and options. `config/sensitive-fields.ts` marks passport fields `ENCRYPTED`. Email actions imported **disabled** |
| 16 | Submissions | 672 items, 43,655 values. Encrypted fields are encrypted during import, so the plain text never lands in Postgres. Files go to the private bucket, checked against their legacy sizes. Legacy consent = `NONE_LEGACY`. IPs are not migrated |
| 17 | Contact | 640 messages, spam flagged by heuristics, nothing deleted |
| 18–19 | Finalise + verify | Rebuild search indexes; compare with the baseline (any difference fails the run); re-hash the private files 100% and a sample of public files; decryption round-trip; SQL check that no encrypted field holds plain text |

## API and permissions (server-enforced; the SPA `can()` only hides UI)

| Permission | Admin | Editor | Translator-en |
|---|---|---|---|
| Articles, categories, HTML blocks, media (sq + en), publish | ✓ | ✓ | EN translations / EN blocks only |
| Application results: view, edit, print, export, reveal (with reason) | ✓ | ✓ | – |
| Delete / Delete All results, field builder, form settings | ✓ | – | – |
| Contact inbox | ✓ | – | – |
| Users, settings, redirects, audit, flags | ✓ | – | – |
| Alumni page | ✓ | ✓ | – |

**Auth:**
- Session cookie (HttpOnly, SameSite) plus a CSRF token on admin writes.
- Rate limits on login, reset and public form posts.
- Password reset by email (lands in Mailpit locally); `user:create-admin` CLI for the first account.

**Public routes:**
- **Pages (server-rendered):** Albanian at the root (`/…`), English under `/en/…`, matching DNN's Albanian default.
- **Content:**
  - `GET /api/public/articles?view=&program=&year=&sort=latest|mostread&page=&lang=`
  - `/api/public/search?q=&program=&year=` (Postgres full text: `simple` + unaccent for Albanian, `english` for EN, document titles included)
- **Files and feeds:** `/files/:id/:variant`, `/docs/:id/:slug` (download counter), `/rss/:feed.xml`, `/sitemap.xml` (hreflang).
- **Forms:**
  - `GET /api/public/forms/:key`
  - `POST /api/public/forms/:key/submissions` (multipart)
  - `POST /api/public/contact`

**Language fallback:** EN pages fall back to the Albanian text when no translation exists, as DNN did; articles with `hideDefaultLocale` are excluded from EN. Serbian is used only for the application form (4349).

**Counters:** views and downloads use atomic increments, bots skipped; no per-request log is kept.

**Admin routes** (`/api/admin/*`; every write and every access to applicant data is audited):
- Auth and `bootstrap` (me, permissions, flags, lookups).
- Articles CRUD (+ translations, documents, gallery, revisions/restore); categories; HTML blocks (+ revisions/restore); media.
- Forms: settings, fields, actions.
- Submissions:
  - paged, masked list; view; edit; delete; Delete All (Admin, typed confirmation, soft delete);
  - reveal with a reason; private file stream; print; export TSV/CSV (personal fields only with a reason); statistics.
- Contact, users, settings, redirects, audit, flags.

## Frontend wiring (reuse the prototype)

**Public site:**
- **Server-rendered shell:** the server loads `web/*.html` and injects lang, title, meta, canonical, hreflang, OG, the GA tag and the translated interface text.
- **Data hand-over:** the page data is embedded as `<script type="application/json">`, which sets `window.PIPS_DATA`. `server/src/site/dto.ts` produces the same shapes `data.js` uses today, for example:
  - person = article title / subtitle / cover / summary;
  - donor = title / cover / link.

  Page scripts and `web/assets/js/render.js` (made usable on the server too) barely change.
- **Lists and search:** `PIPS_loadMore` (`app.js:517`) and `runSearch` (`app.js:357`) fetch from the API.
- **Page → source:**
  - Home: featured slider, latest Activities and Publications, donors, HTML blocks.
  - Activities / Publications: categories 5 / 6 with program and year filters. Research: Publications with `analyticalType`.
  - Staff / Board / Donors: categories 8 / 9 / 10 + 22 + 17.
  - School of Politics: 11 / 13 / 16, testimonials 14, program intros 18–21.
  - About / Contact / Strategy: HTML blocks.
  - Alumni: category 14, Editor-only, as in DNN.
  - Careers, newsletter, alumni directory, generations: static, forms off.
- **Interface text:** Albanian default + English (`web/i18n/{sq,en}.json`, extended from the `app.js` dictionary). Long texts come from the migrated HTML blocks; PIPS must supply Albanian for any prototype-only microcopy.

**`apply.html`:**
- Keep the wizard look, but build the steps from the form definition (headings = steps), so the field builder keeps working.
- `/apliko` → form 4345; `/en/apply` → 4349 (Serbian), as today.
- Real multipart upload:
  - file type checked by sniffing the content;
  - size limits;
  - consent required (stores notice version + time);
  - honeypot and time trap;
  - captcha setting honoured (off, as today).
- On success, the enabled email actions run (into Mailpit locally); the confirmation never contains sensitive fields.

**`contact.html`:** a real POST (replacing `form[data-demo]` in `app.js:600`) plus a notification email.

**Admin SPA:**
- **API seam:**
  - Replace `load()` / `save()` / `initialState()` (`web/admin/admin.js` ~:126–237) with `await A.boot()` and add `A.api()` (CSRF, 401 → login).
  - Routes fetch their own data; each `state…; save(); log()` mutation becomes an API call.
  - Client-side `log()` is removed (the server writes the audit); `can()` uses server permissions.
- **Flags:** NAV items carry a `flag`, and the server returns 404 for flagged-off routes. Flags **off:** stages / kanban, scoring / reviewer role, decision emails, assignment, tags, star, generations, alumni management, careers / job applications, subscribers, newsletter archive, homepage section editor, extra taxonomies, School of Politics program-page editor, 2FA, dashboard extras.
- **Screens kept:**

| Admin screen | DNN function it replaces |
|---|---|
| Articles: one editor, with a category filter and shortcut views (`admin-content.js`) | EasyDNNNews |
| Categories (cut-down taxonomies screen) | EasyDNN category manager |
| HTML blocks with version history (repurposed "Pages" screen) | HTML module |
| Applications: results grid using the legacy result columns, view (masked + reveal), edit, print, export, delete, statistics (`admin-sop.js`) | DigForm Results / Statistics |
| Form builder: fields, settings, email actions (`admin-sop.js` cycles screen, cut down) | DigForm Fields / Settings / submit actions |
| Contact inbox, Users & roles, Media, Settings + redirects, Audit (`admin-org.js`, `admin-content.js`) | Feedback list, DNN users/roles, file manager, portal settings, TabUrls |

## Phases and milestones (each phase ends with a check before the next starts)

| Phase | Deliverables | Exit check |
|---|---|---|
| **P0 Foundations** | Branch, `git mv prototype web`, port the newer admin copy (live code removed), compose (pg, mailpit, legacy restore), Fastify/Prisma skeleton, `.env.example`, `.gitignore` hardening | `docker compose up` → `/health` OK; legacy DB restored read-only; Mailpit reachable |
| **P1 Schema + content migration** | Prisma schema + raw SQL (search, audit trigger); steps 00–04, 08–14, 17–18 | Counts match the baseline; a re-run produces no changes |
| **P2 Files** | Steps 05–07, storage layer, legacy paths, report | ≈4,074 originals; exactly 2 missing; checksums pass |
| **P3 Forms + encryption** | Steps 15–16, crypto, masking, private files | 672 submissions, 2,053 files; no plain text in encrypted fields |
| **P4 Public site** | Server-rendered shell, page map, data adapters, language fallback, sq/en interface text, search, counters, RSS, sitemap, redirects, files | Every page in sq and en served from Postgres; redirect suite green |
| **P5 Public forms** | Dynamic apply wizard, multipart upload, consent, contact, anti-spam, emails | sq and sr submissions visible in admin; both emails in Mailpit |
| **P6 Admin API** | Auth, reset, roles/permissions, all admin endpoints, audit, flags | Permission matrix tests pass (every endpoint × 3 roles + anonymous) |
| **P7 Admin SPA** | `A.boot` / `A.api`, every kept screen rewired, localStorage removed, flags | Every DNN function in the table above can be done end to end |
| **P8 Verify + harden** | Playwright, spot checks against the live site, CSP, backup/restore scripts, runbook, rehearsal from a fresh `.bak` | Sign-off checklist green |

**Effort:** roughly 6–8 developer-weeks of work in total. I'll execute phase by phase, report at each exit check, and commit to `backend-api` (code only, never data).

## Risks and how they're handled
- **SEO / URL continuity:** all 7,665 + 32 legacy URLs, document links and `/Portals` paths get 301s (DigForm paths get 410); canonical, hreflang and sitemap; redirect test against a sample of live URLs.
- **Large files:** streaming hash and copy; HTTP Range support; size limits; the storage layer can switch to S3 later.
- **Spam:** captcha is off today and the inbox has been spam-heavy since 2023. Honeypot, time trap, rate limit and a spam flag are added; a captcha flag is available.
- **Legacy HTML:** decode, sanitise with an allowlist, keep the raw version as a revision, and spot-check visually.
- **Real personal data stored locally:**
  - It lives only in `data/` and the Postgres volume, with passport fields encrypted.
  - Reports contain no personal data; tests and screenshots use a synthetic-data compose project.
  - Encryption keys are backed up outside the repo.
- **Content changes before cutover:** the pipeline is re-runnable, so the final import runs from a fresh `.bak` during a short content freeze.
- **Applicant files possibly public on the old host today:** PIPS should lock `/Portals/0/DigForm` now. The new site answers 410 for those paths.

## Verification (end to end)
1. **Counts:** step 19 vs baseline:
   - 314 articles, 255 EN translations, 55 categories / 316 links, 556 program/year values;
   - 191 documents, 1,518 gallery items (2 missing), 931 revisions, 397 HTML versions;
   - 672 submissions / 43,655 values / 2,053 files, 640 messages, 8 users;
   - 7,665 + 32 redirects, ≈4,074 originals.
2. **Checksums:** sha256 manifest of every original, re-hashed (private 100%, public sample).
3. **Spot checks against the live site** (read-only GETs, low rate): 50 random articles per language plus 20 documents. Compare title, date, categories, document and gallery counts, and body-text similarity (≥ 0.95).
4. **Redirects:** every legacy URL → 301 → 200 on the new page (or 410 for DigForm); never more than one hop.
5. **Permissions:** automated matrix tests of every admin endpoint × Admin / Editor / Translator / anonymous.
6. **Privacy:**
   - SQL check that encrypted fields hold no plain text.
   - Reveal, export, view, print and file download each create an audit row.
   - The audit table rejects UPDATE and DELETE.
7. **Email (Mailpit API):**
   - sq and sr applications with synthetic files → notify + confirmation emails arrive, and the confirmation contains no sensitive fields;
   - contact form → notification email;
   - no SMTP traffic goes anywhere except Mailpit.
8. **Playwright smoke:**
   - every public page in sq and en (200, heading, OG tags);
   - search with program and year filters; load more;
   - document download increments the counter;
   - admin login per role, plus each kept DNN function end to end.
