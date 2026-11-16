# PIPS website: runbook

How to run, import, back up, restore and launch the new pips-ks.org (API, public site and admin).

## What runs where

| Part | Where | Notes |
|---|---|---|
| API + public site + admin | `server/` (Fastify, Node 22) | Port 8080. Public pages are rendered from `web/*.html`; the admin SPA is `web/admin/` at `/admin/`. |
| Database | PostgreSQL 16 (`infra/docker-compose.yml`, service `postgres`) | Port 5440 on 127.0.0.1. Extensions: unaccent, pg_trgm, citext. |
| Files | `data/storage/{public,private}/…` | Content-addressed (`<sha256>.<ext>`). `private/` holds applicants' files and is never served publicly. |
| Email | Mailpit locally (`http://localhost:8025`) | Outside production every email goes to Mailpit; real sending needs `NODE_ENV=production` + `MAIL_MODE=live`. |
| Legacy DNN database | SQL Server (service `legacy-mssql`, profile `legacy`) | Only for the import. Restored from the `.bak`, then set READ_ONLY; the import uses a read-only login. |

Every port is bound to 127.0.0.1. Nothing in `data/`, no `.env`, no `.bak` is ever committed.

## Settings (`.env` in the repository root)

`pnpm --filter @pips/server gen:secrets` prints fresh secrets. Variables:

- **Server:** `NODE_ENV`, `HOST`, `PORT`, `PUBLIC_BASE_URL`, `DATABASE_URL`, `STORAGE_DIR`, `WEB_DIR`.
- **Secrets:** `SESSION_SECRET` (cookies, form tokens), `PII_KEYS` (JSON `{kid: base64 32-byte key}`), `PII_ACTIVE_KID`.
- **Email:** `MAIL_MODE` (`capture` | `live`), `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`.
- **Docker:** `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`.
- **Import only:** `LEGACY_BAK_DIR`, `LEGACY_BAK_FILE`, `LEGACY_SA_PASSWORD`, `LEGACY_READER_PASSWORD`, `LEGACY_MSSQL_PORT`, `LEGACY_PORTALS_DIR` (the copied `Portals/0` folder).

**`PII_KEYS` decrypts passport numbers and dates. Keep a copy of the keys outside the server and outside the backups. Without the keys, those fields cannot be recovered.**

## First-time setup (local)

```bash
pnpm install
pnpm up                                            # postgres + mailpit
pnpm --filter @pips/server prisma migrate deploy   # create the schema
pnpm up:legacy                                     # restore the .bak read-only (first start takes a few minutes)
pnpm migrate run                                   # import everything (≈20 steps, files take longest)
pnpm --filter @pips/server dev                     # http://localhost:8080
pnpm --filter @pips/server user:create-admin --email you@example.org --name "Your Name"
```

`user:create-admin` prints a one-time link (valid 7 days) for choosing the password. It also emails the link (to Mailpit locally).
Imported DNN accounts are `INVITED`, because old passwords are not migrated. Send each person an invitation from **Admin › Users & roles**.

## Import (migration) commands

| Command | What it does |
|---|---|
| `pnpm migrate baseline` | Counts in the legacy database (for comparison) |
| `pnpm migrate run` | All steps in order; each step is re-runnable (upserts by legacy id) |
| `pnpm migrate run --only 08,09` | Selected steps |
| `pnpm migrate digest` | Fingerprints of the imported tables (two runs from the same `.bak` give the same digests) |

Steps 19–21 verify against the source and fail the run on any difference. Each run writes `data/reports/<time>/report.md`, which contains no personal data.

## Checks

```bash
pnpm --filter @pips/server test                                         # unit tests
pnpm --filter @pips/server test:matrix                                  # every admin route × every role, on a throwaway pips_test database
pnpm --filter @pips/server exec tsx --env-file=../.env src/cli/check-redirects.ts   # every old DNN URL → one 301 → 200 (or 410)
```

### Spot check against the live site (read-only)

The old site refuses scripts (HTTP 403), so the live pages are read in a normal browser:

1. `pnpm --filter @pips/server exec tsx --env-file=../.env src/cli/spot-check.ts sample --n 20 --docs 0`
   Picks random articles and writes `data/reports/spot-sample.json` (what our database says) and `spot-urls.json`.
2. In a browser tab on `https://pips-ks.org`, open the DevTools console:
   - set `window.SPOT_URLS` to the contents of `spot-urls.json`;
   - paste `scripts/spot-check-browser.js`;
   - when `window.SPOT_DONE` is true, save `JSON.stringify(SPOT_LIVE)` as `data/reports/spot-live.json`.

   The script reads one page every 1.5 s. If the browser blocks scripted reads, open the URLs one by one and run the same extraction on each page.
3. `… spot-check.ts compare` checks each article against `data/reports/spot-check.md`: title, date (±1 day), gallery and document counts, program and year, and text similarity of at least 0.95.

**Result on 15 Oct 2026:** 40 of 40 articles match (20 sq, 20 en). The tool also flagged all five deliberately altered values in a control run.

## Backups and restore

```bash
scripts/backup.sh                                  # database dump + incremental file copy into data/backups
BACKUP_DIR=/mnt/backup scripts/backup.sh           # elsewhere (keep it on an encrypted disk: it holds personal data)
scripts/restore.sh data/backups/db/pips-<time>.dump --into pips_check            # restore next to the live database to check it
scripts/restore.sh data/backups/db/pips-<time>.dump --replace-live --yes --files  # real restore (stop the API first)
```

- **Schedule:** run `backup.sh` daily (cron/systemd timer). Dumps older than `BACKUP_KEEP_DAYS` (30) are pruned. The file copy never deletes anything.
- **Restore test:** about once a month, restore with `--into` and compare the counts. This was tested on 15 Oct 2026: identical counts, audit protection and search index intact.

## Maintenance

| Task | Command |
|---|---|
| Remove files nothing uses any more (dry run first) | `pnpm --filter @pips/server files:gc --list` then `--apply` |
| Rotate the passport-field key | Add a new key to `PII_KEYS`, set `PII_ACTIVE_KID` to it, restart, then run `pnpm --filter @pips/server pii:rekey --apply`. When it reports 0 remaining, take a backup; only then remove the old key. |
| Logs | The API logs JSON to stdout. Request bodies and cookies are never logged. CSP violations appear as `"csp violation"`. |
| Audit log | Admin › Audit log. The table rejects UPDATE, DELETE and TRUNCATE. |

## Docker image

`pnpm up` plus `docker compose -f infra/docker-compose.yml --env-file .env up -d api` runs the API from `server/Dockerfile`. The image is Node 22 slim, built from the lockfile, and contains no data or secrets (see `.dockerignore`). It applies pending database migrations on start.

**Tested on 15 Oct 2026:** health OK, argon2 and sharp work in the container, and all 59 browser tests pass against it. The image is ~900 MB because it includes development packages; trimming it with `pnpm deploy --prod` is an option before production.

## Cut-over from the old site

**Rehearsal on 15 Oct 2026:** a full import from the `.bak` into a fresh database took 288 s, and all verify steps passed. Its imported content was identical, table by table, to the existing import: articles, translations, categories, documents, applicants' answers and every stored file. Run the same rehearsal before the real cut-over.


1. **Freeze content** on the DNN site (tell editors; leave the application form open or closed as PIPS decides).
2. Take a **fresh `.bak`** and a fresh copy of `Portals/0`. Point `LEGACY_BAK_FILE` / `LEGACY_PORTALS_DIR` at them.
3. `pnpm up:legacy` (fresh restore), then `pnpm migrate run`. All verify steps must pass.
4. `check-redirects`, then `spot-check` against the live site: both must pass.
5. **Production settings:**
   - `NODE_ENV=production`, `PUBLIC_BASE_URL=https://pips-ks.org`;
   - `MAIL_MODE=live` with the real SMTP settings, and `MAIL_FROM` on a pips-ks.org address (DNN used `noreply@appdec.com`);
   - TLS at the reverse proxy.
6. **Switch on the form emails** in Admin › Application forms › Emails. They were imported switched off.
7. **DNS:** point pips-ks.org at the new server. Old URLs are answered with 301s; `/Portals/0/DigForm/*` answers 410.
8. **On the old host:** block `/Portals/0/DigForm/` straight away (applicant files). Keep the old site offline but archived.
9. Submit `https://pips-ks.org/sitemap.xml` to Google Search Console.

## Before launch: still needed from PIPS

- Approval of the consent notice texts (sq, sr) and the data-retention period.
- The sender address for emails, and SMTP access.
- Albanian versions of the remaining prototype texts: `docs/i18n-sq-pending.md`.
- A Google Analytics 4 measurement ID. The imported code is Universal Analytics (`UA-…`), which Google switched off in 2024, so it collects nothing.
- A review of the 86 automatically tagged Research items (Admin › Articles › Research).
- Invitations for the staff accounts, and their roles (Admin › Users & roles).

## Troubleshooting

| Symptom | Check |
|---|---|
| `/health` reports `db: unreachable` | `pnpm up`; check `POSTGRES_PORT` and `DATABASE_URL` |
| No emails | Mailpit at :8025 locally. In production check `MAIL_MODE`, `SMTP_*`, and that the form's email actions are switched on. |
| "This page has expired" on a form | The form token is older than 3 days; reloading the page fixes it |
| Admin says "session has ended" | Sessions end after 12 h without activity or 7 days in any case; sign in again |
| A passport field shows "no key for kid" | `PII_KEYS` is missing the key named in the error. Restore it from the key backup. |
