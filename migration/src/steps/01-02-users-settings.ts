import { select } from "../legacy/mssql.js";
import { db } from "../db.js";
import { clean, decodeHtml } from "../lib/text.js";
import type { Step } from "./types.js";

/** Legacy DNN role → new role. Other DNN roles (Registered Users, Subscribers, …) carry no permissions. */
const ROLE_MAP: Record<number, { key: string; name: string }> = {
  0: { key: "administrator", name: "Administrator" },
  7: { key: "editor", name: "Editor" },
  6: { key: "translator_en", name: "Translator (English)" },
};

export const usersStep: Step = {
  id: "01",
  name: "users and roles (no passwords migrated; all accounts INVITED)",
  async run() {
    for (const [legacyId, r] of Object.entries(ROLE_MAP)) {
      await db.role.upsert({ where: { key: r.key }, update: { name: r.name, legacyId: Number(legacyId) }, create: { key: r.key, name: r.name, legacyId: Number(legacyId) } });
    }
    const users = await select<{ UserID: number; Username: string; FirstName: string; LastName: string; DisplayName: string; Email: string | null; IsSuperUser: boolean; IsDeleted: boolean }>(
      "SELECT UserID, Username, FirstName, LastName, DisplayName, Email, IsSuperUser, IsDeleted FROM Users ORDER BY UserID",
    );
    const seenEmails = new Set<string>();
    for (const u of users) {
      let email = (clean(u.Email) ?? `${u.Username}@users.invalid`).toLowerCase();
      if (seenEmails.has(email)) email = email.replace("@", `+${u.UserID}@`);
      seenEmails.add(email);
      const data = {
        username: u.Username, email,
        firstName: clean(u.FirstName) ?? "", lastName: clean(u.LastName) ?? "",
        displayName: clean(u.DisplayName) ?? u.Username,
        isSuperUser: u.IsSuperUser,
        status: u.IsDeleted ? ("DISABLED" as const) : ("INVITED" as const),
      };
      await db.user.upsert({ where: { legacyId: u.UserID }, update: data, create: { ...data, legacyId: u.UserID } });
    }
    const memberships = await select<{ UserID: number; RoleID: number }>(
      `SELECT UserID, RoleID FROM UserRoles WHERE RoleID IN (${Object.keys(ROLE_MAP).join(",")})`,
    );
    const userIds = new Map((await db.user.findMany({ select: { id: true, legacyId: true } })).map(u => [u.legacyId, u.id]));
    const roleIds = new Map((await db.role.findMany()).map(r => [r.legacyId, r.id]));
    let links = 0;
    for (const m of memberships) {
      const userId = userIds.get(m.UserID), roleId = roleIds.get(m.RoleID);
      if (!userId || !roleId) continue;
      await db.userRole.upsert({ where: { userId_roleId: { userId, roleId } }, update: {}, create: { userId, roleId } });
      links++;
    }
    return { users: users.length, roles: Object.keys(ROLE_MAP).length, userRoles: links };
  },
};

const SECRET_SETTING = /smtp|password|secret|key|token|hash/i;

export const settingsStep: Step = {
  id: "02",
  name: "site settings (name, description, logo, favicon, analytics, social links)",
  async run() {
    const loc = await select<{ CultureCode: string; PortalName: string; LogoFile: string | null; FooterText: string | null; Description: string | null; KeyWords: string | null }>(
      "SELECT CultureCode, PortalName, LogoFile, FooterText, Description, KeyWords FROM PortalLocalization WHERE PortalID = 0",
    );
    const by = (c: string) => loc.find(l => l.CultureCode === c) ?? loc[0];
    const sq = by("sq-AL"), en = by("en-GB");
    const ps = await select<{ SettingName: string; SettingValue: string; CultureCode: string | null }>(
      "SELECT SettingName, SettingValue, CultureCode FROM PortalSettings WHERE PortalID = 0",
    );
    const setting = (n: string) => ps.find(p => p.SettingName === n && !p.CultureCode)?.SettingValue ?? ps.find(p => p.SettingName === n)?.SettingValue;

    let faviconLegacyPath: string | null = null;
    const fav = /FileID=(\d+)/i.exec(setting("FavIconPath") ?? "");
    if (fav) {
      const f = await select<{ Folder: string | null; FileName: string }>(`SELECT Folder, FileName FROM Files WHERE FileId = ${Number(fav[1])}`);
      if (f[0]) faviconLegacyPath = `/Portals/0/${f[0].Folder ?? ""}${f[0].FileName}`;
    }

    // Social links appear in the footer HTML blocks.
    const html = await select<{ Content: string }>(
      "SELECT h.Content FROM HtmlText h WHERE h.IsPublished = 1 AND h.ModuleID IN (SELECT ModuleID FROM Modules WHERE AllTabs = 1 AND IsDeleted = 0)",
    );
    const social: Record<string, string> = {};
    for (const h of html) {
      for (const m of decodeHtml(h.Content).matchAll(/href="(https?:\/\/(?:www\.)?(facebook|twitter|x|instagram|linkedin|youtube)\.com\/[^"]+)"/gi)) {
        const net = m[2].toLowerCase() === "x" ? "twitter" : m[2].toLowerCase();
        social[net] ??= m[1];
      }
    }

    const values: Record<string, unknown> = {
      "site.name": { sq: sq?.PortalName, en: en?.PortalName },
      "site.description": { sq: clean(sq?.Description), en: clean(en?.Description) },
      "site.keywords": { sq: clean(sq?.KeyWords), en: clean(en?.KeyWords) },
      "site.footerText": { sq: clean(sq?.FooterText), en: clean(en?.FooterText) },
      "site.logoLegacyPath": sq?.LogoFile ? `/Portals/0/${sq.LogoFile}` : null,
      "site.faviconLegacyPath": faviconLegacyPath,
      "site.timeZone": setting("TimeZone") ?? null,
      "site.social": social,
      "analytics.headHtml": setting("PageHeadText") ?? null,
      "legacy.portalSettings": Object.fromEntries(ps.filter(p => !SECRET_SETTING.test(p.SettingName)).map(p => [`${p.SettingName}${p.CultureCode ? "@" + p.CultureCode : ""}`, p.SettingValue])),
    };
    for (const [key, value] of Object.entries(values)) {
      await db.setting.upsert({ where: { key }, update: { value: value as object }, create: { key, value: value as object } });
    }
    return { settings: Object.keys(values).length, socialLinks: Object.keys(social).length };
  },
};
