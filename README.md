# PIPS backend

API, database, and file storage for [pips-ks.org](https://pips-ks.org), the public site of the Prishtina Institute for Political Studies. The institute was founded in 2004. Its work is capacity building, policy research, political dialogue, and Euro-Atlantic integration. The flagship program is the School of Politics, which has trained a generation-by-generation network of Kosovo's political class since 2003 (24 generations, 800+ alumni).

This repository is the backend only. The HTML, CSS, and browser scripts live in the frontend and are not stored here.

Stack: Node 22, Fastify, PostgreSQL 16, Prisma. The API renders the public pages, accepts the public forms, and serves the staff admin.

## What the site has to do

People come to the site for three things:

- Prospective School of Politics applicants (mostly on phones) need to understand the School and apply on the site.
- Researchers, journalists, policymakers, and donors need to find research and publications, read them in the page, and judge that the institute is credible.
- Alumni and staff need their generation, the news, and a way for PIPS to publish without a developer.

Product rules the pages should keep:

1. The School of Politics is the heart. Every page should be at most one step from it.
2. Research is read in the page, never behind a forced download.
3. One source of truth per content type. The Board lives under About. The School links to it.
4. Templates have to survive real, uneven content. Staff publish it themselves.
5. Serious, not stiff.

Languages in production are Albanian (default, at `/`) and English (under `/en`). An untranslated English article falls back to the Albanian text unless that article hides the default locale. Serbian is not a rendered locale yet. The script (Latin or Cyrillic) is still an open product decision.

Brand the frontend should keep: Ink `#111111` and Signal Gold `#FFCC02`. Archivo for display, Inter for body. Gold is for actions, active states, and tags. It is never body text and it never sits behind long text. The target is WCAG 2.2 AA, phone-first.

## Connect a frontend

The API and the pages are one origin. There is no CORS middleware. Calls from another origin fail, and the admin session cookie is not sent cross-site. Point the frontend at this process, or proxy this process behind the same host.

```bash
cp .env.example .env
pnpm --filter @pips/server gen:secrets   # paste SESSION_SECRET and PII_KEYS into .env
pnpm install
pnpm up                                  # Postgres + Mailpit
pnpm --filter @pips/server prisma migrate deploy
pnpm --filter @pips/server dev           # http://127.0.0.1:8080
```

Set `WEB_DIR` in `.env` to the frontend root. The default is `./web`, resolved from the repository root. A sibling checkout is `WEB_DIR=../pips-web`. Restart the API after changing it.

`GET /health` returns `{ "status": "ok", "db": "ok" }` when the database is up.

The frontend directory must look like this:

```
WEB_DIR/
  index.html                 one HTML file per template (see the table below)
  favicon.ico
  assets/                    served as-is at /assets/…
    js/data.js               required; see below
    css/  js/  img/
  i18n/sq.json               Albanian interface strings
  admin/                     staff SPA, served at /admin/
    index.html
```

Only `/assets/…`, `/admin/…`, and `/favicon.ico` are served as static files. Root `*.html` files are templates. The API reads them and sends the rendered page. A request for `/about.html` is redirected to the pretty path.

### What the server injects

Each public template needs this tag. The server replaces it and does not send `data.js` to the browser:

```html
<script src="assets/js/data.js"></script>
```

The replacement sets three globals:

| Global | What it is |
|---|---|
| `window.PIPS_DATA` | Lists and static copy for that page |
| `window.PIPS_PAGE` | The current page: `key`, `lang` (`sq` or `en`), `query`, and any form payload |
| `window.PIPS_ROUTES` | `{ lang, files, paths }`. `files` maps `about.html` to a page key. `paths` maps that key to the pretty URL for the current language |

`assets/js/data.js` must still exist and must assign `window.PIPS_DATA`. The server executes it once at startup and keeps four keys that have no database table: `generations`, `sop`, `about`, `contact`. Those values are copied into `PIPS_DATA` on every page. Everything else in that file (articles, people, publications) is ignored. The database is the source for those.

`PIPS_DATA` keys the templates already use:

| Key | Source |
|---|---|
| `lang` | `sq` or `en` |
| `activities`, `publications`, `research` | Published articles. `research` is the publications flagged analytical |
| `staff`, `board` | People articles |
| `donors` | Donors and partners, de-duplicated by name |
| `testimonials` | Alumni quotes for the School page |
| `pipsEngages` | Activities in the “PIPS engages” category |
| `programs` | Program name, key, and summary |
| `generations`, `sop`, `about`, `contact` | From `assets/js/data.js` |
| `years` | Years present on articles, newest first |
| `associates` | Always `[]` today |

List templates (`activities.html`, `publications.html`, `research.html`, `news.html`, `programs.html`) receive the full lists. Other templates receive a short slice, because the header search calls the API instead of filtering a giant payload. Home gets 12 activities (featured ones are kept) and 6 publications and research items.

On an article page, `PIPS_PAGE` also has `id`, `type` (`research` or `publication`), and `item`:

```json
{
  "id": "4182",
  "title": "…",
  "subtitle": null,
  "bodyHtml": "…",
  "summaryHtml": "…",
  "fallbackLang": null,
  "type": "publication",
  "gallery": ["/files/12/v/w1600/cover.webp"],
  "galleryThumbs": ["/files/12/v/w400/cover.webp"],
  "videos": ["https://www.youtube-nocookie.com/embed/…"],
  "documents": [{ "id": 3, "title": "…", "url": "/docs/3/report.pdf", "ext": "pdf", "size": 120000 }],
  "pdfInline": "/docs/3/report.pdf?inline=1"
}
```

`fallbackLang: "sq"` means the English page is showing the Albanian text.

The server rewrites `href="about.html"` (and `activity.html?id=`) to the pretty path, and a small script does the same for links the page scripts add later. Prototype-only markup (`.proto-note`, `.proto-only`) is hidden. Albanian pages get the string dictionary from `i18n/sq.json` applied to the HTML.

### Public paths

Albanian path, then English. Article URLs add `/{id}` or `/{id}/{slug}`.

| Page key | Template | Albanian | English |
|---|---|---|---|
| home | `index.html` | `/` | `/en` |
| about | `about.html` | `/per-ne` | `/en/about-us` |
| board | `board.html` | `/per-ne/bordi` | `/en/about-us/board` |
| staff | `staff.html` | `/per-ne/stafi` | `/en/about-us/staff` |
| strategy | `strategy.html` | `/per-ne/strategjia` | `/en/about-us/strategy` |
| careers | `careers.html` | `/per-ne/karriera` | `/en/about-us/careers` |
| donors | `donors.html` | `/donatoret` | `/en/donors` |
| school-of-politics | `school-of-politics.html` | `/shkolla-politike` | `/en/school-of-politics` |
| generation | `generation.html` | `/shkolla-politike/gjenerata` | `/en/school-of-politics/generation` |
| apply | `apply.html` | `/aplikimi` | `/en/apply` |
| programs | `programs.html` | `/programet` | `/en/programs` |
| activities | `activities.html` | `/aktivitetet` | `/en/activities` |
| research | `research.html` | `/hulumtime` | `/en/research` |
| publications | `publications.html` | `/publikimet` | `/en/publications` |
| alumni | `alumni.html` | `/alumni` | none |
| news | `news.html` | `/lajme` | `/en/news` |
| contact | `contact.html` | `/kontakti` | `/en/contact` |
| search | `search.html` | `/kerkimi` | `/en/search` |

Detail templates are `activity.html` and `item.html`. A link-only article redirects to its external URL. `/alumni` requires a signed-in staff session with `page.alumni.view`. Anyone else gets a short HTML gate, not the template.

Also served: `/sitemap.xml`, `/robots.txt`, `/rss/activities.xml`, `/rss/publications.xml`, and the same feeds under `/en/rss/`. Old DNN URLs answer with 301. `/Portals/0/DigForm/…` answers 410. Those applicant files are never public.

### Files the pages can request

| URL | Use |
|---|---|
| `/files/{id}/{filename}` | Original public file |
| `/files/{id}/v/{w400\|w800\|w1600}/{name}.webp` | Image variant. Use these in cards and heroes |
| `/docs/{id}/{filename}` | Document download. Counts as a download |
| `/docs/{id}/{filename}?inline=1` | Same file, shown in the page (the PDF viewer) |

The private bucket is not on these routes. Applicant uploads are only available through the admin API.

### Search

```
GET /api/public/search?q=democracy&lang=sq&program=school-of-politics&year=2024&page=1
```

`q` is required (max 200 characters). `lang` is `sq` or `en` (anything else is treated as `sq`). `program` is a program key. `year` is a number. Page size is 20.

```json
{
  "q": "democracy",
  "page": 1,
  "total": 4,
  "items": [
    {
      "id": 4182,
      "title": "…",
      "date": "4 shk 2026",
      "lang": "sq",
      "snippet": "… <mark>democracy</mark> …",
      "kind": "publication",
      "href": "/publikimet/4182/slug"
    }
  ]
}
```

An empty `q` returns `{ "q": "", "total": 0, "items": [] }`. `kind` is `activity` or `publication`. `snippet` may contain `<mark>` and is otherwise escaped.

### Contact form

The contact template receives `PIPS_PAGE.contact` (`fields`, `maxMessage`) and `PIPS_PAGE.formToken`. Field visibility is `required`, `optional`, or `hidden`, chosen in the admin. Hidden fields must be sent as empty strings.

```
POST /api/public/contact
Content-Type: application/json

{
  "lang": "sq",
  "name": "…",
  "email": "…",
  "telephone": "",
  "street": "",
  "subject": "…",
  "message": "…",
  "website": "",
  "_t": "<formToken>"
}
```

`website` is a honeypot. Leave it empty. A filled honeypot returns `{ "ok": true }` and stores nothing. `_t` is the token from the page. The token is rejected for 3 seconds after it was issued (`400` `tooFast`) and after 3 days (`400` `expired`). On `tooFast`, wait and send the same body again. On `expired`, reload the page for a new token.

Success is `{ "ok": true }`. Validation failure is `422`:

```json
{ "error": "invalid", "errors": { "email": "email", "message": "tooLong" } }
```

Other `errors` values are `required`. Rate limit is 10 requests an hour per client (`429`).

### School of Politics application

The apply template receives `PIPS_PAGE.form` and `PIPS_PAGE.formToken`. Use `form.key` from that object. The imported keys are `sop-application-sq` on the Albanian page and `sop-application-sr` on the English page.

To build the wizard without a full page load:

```
GET /api/public/forms/sop-application-sq
```

Response: the same form shape as `PIPS_PAGE.form`, plus `token`. Cache is `no-store`. `404` when the key does not exist.

Form shape:

```json
{
  "key": "sop-application-sq",
  "lang": "sq",
  "title": "…",
  "open": true,
  "submitText": "…",
  "requiredText": "…",
  "thankYouHtml": null,
  "steps": [
    {
      "title": "…",
      "sections": [
        {
          "code": "…",
          "title": "…",
          "info": null,
          "fields": [
            {
              "id": 1,
              "code": "emri",
              "type": "TEXT",
              "label": "Emri",
              "required": true,
              "help": null,
              "info": null,
              "options": null,
              "accept": null,
              "maxLength": 200,
              "encrypted": false
            }
          ]
        }
      ]
    }
  ],
  "consent": { "id": 4, "version": 1, "text": "…" }
}
```

Submit with `multipart/form-data`, one part per field `code`, plus:

| Part | Value |
|---|---|
| `_t` | The form token |
| `website` | Honeypot. Leave empty |
| `_consent` | `1` when the box is checked. Required when `consent` is not null |
| `_notice` | `consent.id` |

Files: one file per `FILE` field, max 10 MB. `accept` is the extension list from the form definition.

```
POST /api/public/forms/{key}/submissions
```

Success:

```json
{ "ok": true, "ref": 1204, "thankYouHtml": "<p>…</p>" }
```

| Status | `error` | Meaning |
|---|---|---|
| 410 | `closed` | `open` is false |
| 415 | `multipart` | Body was not multipart |
| 400 | `tooFast` / `expired` | Token timing. Refresh the token with `GET /api/public/forms/{key}` and retry once |
| 400 | `consent` | Missing or wrong consent |
| 413 | `invalid` | `errors[code] = "fileSize"` |
| 422 | `invalid` | `errors` maps field codes to reasons |
| 429 | | 30 submissions an hour per client |

## Admin

The staff UI is the static app at `/admin/` (the API redirects `/admin` to `/admin/`). It talks only to `/api/admin`. Nothing is stored in the browser except the session cookie.

```
POST /api/admin/auth/login
Content-Type: application/json
{ "login": "person@pips-ks.org", "password": "…" }
```

Success sets `pips_sid` (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production) and returns `{ "ok": true, "csrf": "…" }`. Then:

```
GET /api/admin/bootstrap
```

returns `{ user, permissions, csrf, flags, lookups }`. `lookups` has `langs`, `categories`, `programs`, and `forms`. Keep `csrf` and send it on every write:

```
x-csrf-token: <csrf>
credentials: same-origin
```

`GET` and `HEAD` do not need the header. A missing or wrong token is `403` `{ "error": "csrf" }`. No session is `401` `{ "error": "unauthenticated" }`. A role without the permission is `403` `{ "error": "forbidden" }`.

Sessions end after 12 hours idle, and after 7 days regardless. Passwords are at least 12 characters.

Create the first administrator (prints a 7-day set-password link, also emailed to Mailpit locally):

```bash
pnpm --filter @pips/server user:create-admin --email you@example.org --name "Your Name"
```

Roles: `administrator` (everything), `editor` (content, applications, alumni page), `translator_en` (English article text and English HTML blocks only). Feature flags (`applications.scoring`, `newsletter`, `auth.twoFactor`, and the others) default to off. The admin should hide those screens while `flags[key]` is false. The permission list is enforced on the server.

Admin route groups, all under `/api/admin`:

| Area | Routes |
|---|---|
| Session | `POST /auth/login`, `POST /auth/logout`, `POST /auth/forgot`, `POST /auth/reset`, `POST /auth/password` |
| Start | `GET /bootstrap`, `GET /dashboard` |
| Articles | `GET/POST /articles`, `GET/PUT /articles/:id`, `PUT /articles/:id/translations/:lang`, revisions, documents, gallery, cover |
| Taxonomy | `GET/POST/PUT /categories`, `GET/POST/PUT /programs`, `GET/PUT /html-blocks/:id` |
| Media | `GET/POST /media` |
| Forms | `GET /forms`, `GET/PUT /forms/:id`, fields, field order, email actions, consent notices |
| Applications | `GET /forms/:id/submissions`, `GET/PUT /submissions/:id`, `POST /submissions/:id/reveal`, `GET /submissions/:id/files/:fieldId`, `GET /forms/:id/export`, `GET /forms/:id/statistics` |
| Contact inbox | `GET /contact`, `GET/PATCH /contact/:id` |
| Organisation | `GET/POST /users`, `PUT /users/:id`, `POST /users/:id/invite`, `GET/PUT /settings/:key`, `GET/PUT /pages/:id`, `GET/POST/PUT /redirects`, `GET /audit`, `GET/PUT /flags/:key` |

Writes are JSON except file uploads, which are multipart. Admin responses send `Cache-Control: no-store`.

`POST /submissions/:id/reveal` is how a permitted user reads an encrypted passport field. Send a reason. The read is audited. Do not put passport values in a public page.

## Local services

| Service | Address |
|---|---|
| API | `http://127.0.0.1:8080` |
| Postgres | `127.0.0.1` and `POSTGRES_PORT` from `.env` (compose default 5440) |
| Mailpit (every email outside production) | `http://127.0.0.1:8025` |

Every port binds to `127.0.0.1`. `.env` is never committed. `PII_KEYS` decrypts passport numbers and dates. Keep a copy of the keys outside the server and outside the backups. Without the keys those fields cannot be recovered.

Content from the old DotNetNuke site is imported with `pnpm migrate`, which needs the legacy SQL Server backup and `Portals/0`. That step is separate from connecting the frontend. Until it has been run, the pages render with empty lists and the static `data.js` keys.

Operations (backups, the import steps, cut-over) are in `docs/runbook.md`. The content model and the legacy inventory are in `docs/backend-plan.md`.
