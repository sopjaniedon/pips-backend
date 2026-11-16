// Mapping of legacy DNN pages (Tabs) to the new site's routes. New URLs stay close to the old ones for SEO.
// The server's route table (server/src/site/routes.ts, phase P4) must use the same paths.

export type Lang = "sq" | "en";

export interface RouteDef { key: string; sq: string | null; en: string | null }

export const ROUTES: RouteDef[] = [
  { key: "home", sq: "/", en: "/en" },
  { key: "about", sq: "/per-ne", en: "/en/about-us" },
  { key: "school-of-politics", sq: "/shkolla-politike", en: "/en/school-of-politics" },
  { key: "programs", sq: "/programet", en: "/en/programs" },
  { key: "activities", sq: "/aktivitetet", en: "/en/activities" },
  { key: "publications", sq: "/publikimet", en: "/en/publications" },
  { key: "contact", sq: "/kontakti", en: "/en/contact" },
  { key: "apply", sq: "/aplikimi", en: "/en/apply" },
  { key: "search", sq: "/kerkimi", en: "/en/search" },
  { key: "alumni", sq: "/alumni", en: null },
];

export const routePath = (key: string, lang: Lang): string => {
  const r = ROUTES.find(x => x.key === key);
  return (r && (r[lang] ?? r.sq)) || (lang === "en" ? "/en" : "/");
};

/** Article detail URL: section by primary category; id + slug (slug mismatches 301 to canonical at runtime). */
export const articlePath = (section: "activities" | "publications", lang: Lang, id: number, slug: string): string =>
  `${routePath(section, lang)}/${id}/${slug}`;

/** Legacy TabID → route key. Pages without a public equivalent map to the home page. */
export const TAB_ROUTES: Record<number, string> = {
  21: "home", 1101: "home",
  33: "about", 1105: "about",
  35: "school-of-politics", 1106: "school-of-politics",
  36: "programs", 1107: "programs",
  37: "activities", 1108: "activities",
  38: "publications", 1109: "publications",
  42: "contact", 1110: "contact",
  43: "activity", 1111: "activity", // detail pages (articles in category Aktivitetet)
  44: "publication", 1112: "publication", // detail pages (Publikimet)
  45: "apply", 1113: "apply",
  23: "search", 1103: "search",
  24: "not-found", 1104: "not-found",
  1117: "alumni",
  1118: "webmail",
  1119: "backup",
  22: "activity-feed", 25: "activity-feed", 26: "activity-feed", 27: "activity-feed",
  1102: "activity-feed", 1114: "activity-feed", 1115: "activity-feed", 1116: "activity-feed",
};

/** Where a legacy page's old URLs should land. */
export function tabTarget(tabId: number, lang: Lang): string {
  const key = TAB_ROUTES[tabId];
  if (!key || ["activity-feed", "not-found", "webmail", "backup"].includes(key)) return routePath("home", lang);
  if (key === "activity") return routePath("activities", lang);
  if (key === "publication") return routePath("publications", lang);
  return routePath(key, lang);
}

/** Legacy category ids by role in the new site (EasyDNNNewsCategoryList.CategoryID). */
export const CATEGORY = {
  activities: 5,
  publications: 6,
  aboutRoot: 2, pipsEngages: 7, team: 8, board: 9, donors: 10,
  sopRoot: 3, sopAbout: 11, worldForum: 13, alumni: 14, network: 16,
  programsRoot: 4, programIntros: [18, 19, 20, 21],
  partners: 17, donors2: 22,
} as const;

/** Legacy custom fields (EasyDNNfields.CustomFieldID). */
export const CUSTOM_FIELD = { programs: 3, year: 4 } as const;
